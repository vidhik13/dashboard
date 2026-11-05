import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const COLLECTIONS = ["dispatch", "shifts", "returns", "receipts"];
const BATCH_SIZE = 450;
const backupCollection = kind => `carton_tracker_backup_${kind}`;

function getFirestoreDatabase() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!projectId || !clientEmail || !privateKey)
    throw new Error("Firebase Admin credentials are not configured.");

  const appName = "carton-return-tracker-backup";
  const app = getApps().find(existing => existing.name === appName)
    || initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) }, appName);
  return getFirestore(app);
}

function validateRecord(kind, record) {
  if (!COLLECTIONS.includes(kind))
    throw new Error("Invalid Firebase backup collection.");
  if (typeof record?.id !== "string" || !record.id || record.id.includes("/"))
    throw new Error("A Firebase backup record has an invalid ID.");
}

export async function writeFirebaseBackupRecord(kind, record) {
  validateRecord(kind, record);
  await getFirestoreDatabase().collection(backupCollection(kind)).doc(record.id).set(record);
}

export async function deleteFirebaseBackupRecord(kind, id) {
  if (!COLLECTIONS.includes(kind) || typeof id !== "string" || !id || id.includes("/"))
    throw new Error("A Firebase backup record has an invalid ID.");
  await getFirestoreDatabase().collection(backupCollection(kind)).doc(id).delete();
}

export async function writeFirebaseBackupSettings(settings) {
  await getFirestoreDatabase()
    .collection("carton_tracker_backup_settings")
    .doc("dashboard")
    .set({ ...settings, id: "dashboard" });
}

export async function syncFirebaseBackup(data) {
  const db = getFirestoreDatabase();
  for (const kind of COLLECTIONS) {
    const records = data[kind] || [];
    const incomingIds = new Set();
    for (const record of records) {
      validateRecord(kind, record);
      if (incomingIds.has(record.id))
        throw new Error(`Google Sheets contains duplicate IDs in the ${kind} records.`);
      incomingIds.add(record.id);
    }

    const collection = db.collection(backupCollection(kind));
    const existing = await collection.get();
    const operations = [
      ...records.map(record => ({ ref: collection.doc(record.id), data: record })),
      ...existing.docs
        .filter(document => !incomingIds.has(document.id))
        .map(document => ({ ref: document.ref, delete: true })),
    ];
    for (let start = 0; start < operations.length; start += BATCH_SIZE) {
      const batch = db.batch();
      for (const operation of operations.slice(start, start + BATCH_SIZE)) {
        if (operation.delete) batch.delete(operation.ref);
        else batch.set(operation.ref, operation.data);
      }
      await batch.commit();
    }
  }

  const settingsDocument = db.collection("carton_tracker_backup_settings").doc("dashboard");
  if (data.settings)
    await settingsDocument.set({ ...data.settings, id: "dashboard" });
  else await settingsDocument.delete();
  return { status: "synced", message: "Firebase backup updated from Google Sheets." };
}

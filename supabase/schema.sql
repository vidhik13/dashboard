create table if not exists public.carton_records (
  kind text not null check (kind in ('dispatch', 'shifts', 'returns', 'receipts')),
  id text not null,
  factory text,
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  primary key (kind, id)
);

create index if not exists carton_records_factory_kind_idx
  on public.carton_records (factory, kind);

create table if not exists public.carton_settings (
  id smallint primary key default 1 check (id = 1),
  data jsonb not null check (jsonb_typeof(data) = 'object')
);

alter table public.carton_records enable row level security;
alter table public.carton_settings enable row level security;

revoke all on public.carton_records from anon, authenticated;
revoke all on public.carton_settings from anon, authenticated;
grant all on public.carton_records to service_role;
grant all on public.carton_settings to service_role;

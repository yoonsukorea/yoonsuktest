create table if not exists public.household_data (
	user_id uuid primary key references auth.users (id) on delete cascade,
	data jsonb not null,
	revision bigint not null default 1 check (revision > 0),
	migration_id uuid not null,
	updated_at timestamptz not null default now()
);

alter table public.household_data enable row level security;
revoke all on table public.household_data from anon, public;
grant select, insert, update on table public.household_data to authenticated;

create or replace function public.set_household_data_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
	new.updated_at = now();
	return new;
end
$$;

drop trigger if exists set_household_data_updated_at on public.household_data;
create trigger set_household_data_updated_at
	before update on public.household_data
	for each row execute function public.set_household_data_updated_at();

drop policy if exists "Users can read their household data" on public.household_data;
create policy "Users can read their household data"
	on public.household_data for select
	to authenticated
	using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their household data" on public.household_data;
create policy "Users can create their household data"
	on public.household_data for insert
	to authenticated
	with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their household data" on public.household_data;
create policy "Users can update their household data"
	on public.household_data for update
	to authenticated
	using ((select auth.uid()) = user_id)
	with check ((select auth.uid()) = user_id);

do $$
begin
	if not exists (
		select 1
		from pg_publication_tables
		where pubname = 'supabase_realtime'
			and schemaname = 'public'
			and tablename = 'household_data'
	) then
		alter publication supabase_realtime add table public.household_data;
	end if;
end
$$;

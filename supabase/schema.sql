-- Bons Plans Canada - Étape 4 : comptes et alertes
-- À coller UNE FOIS dans Supabase : SQL Editor -> New query -> Run.
-- Peut être relancé sans danger (il ne détruit rien).

-- ---------------------------------------------------------------
-- 1. Souhaits (la liste de chaque personne)
-- ---------------------------------------------------------------
create table if not exists public.souhaits (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  texte    text not null check (char_length(texte) between 1 and 100),
  cree_le  timestamptz not null default now(),
  unique (user_id, texte)
);
create index if not exists souhaits_user_idx on public.souhaits (user_id);

-- ---------------------------------------------------------------
-- 2. Profils (sujet ntfy privé + alertes oui/non)
-- ---------------------------------------------------------------
create table if not exists public.profils (
  user_id         uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  ntfy_sujet      text not null unique
                  default substr(replace(gen_random_uuid()::text, '-', ''), 1, 24),
  alertes_actives boolean not null default true,
  dernier_envoi   timestamptz
);

-- ---------------------------------------------------------------
-- 3. Alertes déjà envoyées (réservé au service : aucun accès public)
-- ---------------------------------------------------------------
create table if not exists public.alertes_envoyees (
  user_id   uuid not null references auth.users (id) on delete cascade,
  lien      text not null,
  envoye_le timestamptz not null default now(),
  primary key (user_id, lien)
);

-- ---------------------------------------------------------------
-- 4. Sécurité : RLS activée partout, rien de public
-- ---------------------------------------------------------------
alter table public.souhaits         enable row level security;
alter table public.profils          enable row level security;
alter table public.alertes_envoyees enable row level security;

revoke all on public.souhaits         from anon;
revoke all on public.profils          from anon;
revoke all on public.alertes_envoyees from anon, authenticated;

-- souhaits : chaque personne ne voit et ne touche que les siens
drop policy if exists souhaits_select on public.souhaits;
drop policy if exists souhaits_insert on public.souhaits;
drop policy if exists souhaits_update on public.souhaits;
drop policy if exists souhaits_delete on public.souhaits;
create policy souhaits_select on public.souhaits for select to authenticated
  using (user_id = (select auth.uid()));
create policy souhaits_insert on public.souhaits for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy souhaits_update on public.souhaits for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy souhaits_delete on public.souhaits for delete to authenticated
  using (user_id = (select auth.uid()));

-- profils : idem
drop policy if exists profils_select on public.profils;
drop policy if exists profils_insert on public.profils;
drop policy if exists profils_update on public.profils;
drop policy if exists profils_delete on public.profils;
create policy profils_select on public.profils for select to authenticated
  using (user_id = (select auth.uid()));
create policy profils_insert on public.profils for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy profils_update on public.profils for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy profils_delete on public.profils for delete to authenticated
  using (user_id = (select auth.uid()));

-- profils : une personne peut seulement changer "alertes_actives"
-- (elle ne peut pas choisir le sujet ntfy d'un autre ni toucher dernier_envoi).
revoke insert, update on public.profils from authenticated;
grant  insert (user_id, alertes_actives) on public.profils to authenticated;
grant  update (alertes_actives)          on public.profils to authenticated;

-- ---------------------------------------------------------------
-- 5. Limite de 50 souhaits par personne (protège le plan gratuit)
-- ---------------------------------------------------------------
create or replace function public.limiter_souhaits()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext(new.user_id::text));
  if (select count(*) from public.souhaits where user_id = new.user_id) >= 50 then
    raise exception 'Limite de 50 souhaits atteinte';
  end if;
  return new;
end $$;
drop trigger if exists souhaits_limite on public.souhaits;
create trigger souhaits_limite before insert on public.souhaits
  for each row execute function public.limiter_souhaits();

revoke truncate, references, trigger on public.souhaits, public.profils from authenticated, anon;

-- ---------------------------------------------------------------
-- 6. Création automatique du profil à l'inscription
-- ---------------------------------------------------------------
create or replace function public.creer_profil()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profils (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;
revoke all on function public.creer_profil()     from public, anon, authenticated;
revoke all on function public.limiter_souhaits() from public, anon, authenticated;

drop trigger if exists a_la_creation_du_compte on auth.users;
create trigger a_la_creation_du_compte after insert on auth.users
  for each row execute function public.creer_profil();

-- Profils pour les comptes déjà existants (s'il y en a)
insert into public.profils (user_id) select id from auth.users on conflict do nothing;

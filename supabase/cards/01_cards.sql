-- КОЛЛЕКЦИОННЫЕ КАРТОЧКИ, этап 1: колода, открытие, переплавка, витрина.
--
-- Как устроено (простыми словами):
-- * Серия «Начало» — 20 карточек пяти редкостей. Все 85 копий созданы сразу, у каждой свой номер
--   («№2 из 4»). Пока у копии нет хозяина, она лежит в колоде. Больше напечатанного не появится никогда.
-- * «Открыть карточку» — база берёт случайную копию из колоды и отдаёт её тебе. Исход решает только база.
-- * Цена зависит от самой редкой карточки, что ещё есть в колоде: золотая 300, фиолетовая 250,
--   синяя 200, зелёная 150, только серые 100.
-- * Переплавка: копия исчезает, монеты возвращаются (15 / 30 / 60 / 150). Последнюю копию карточки
--   во всей игре (колода тоже считается) переплавить нельзя — одна полная коллекция всегда в игре.
-- * Траты и возвраты — записи в той же книге монет (points_ledger) с видом 'cards'.
-- * История каждой копии (card_events) пишется с первого дня: открыта, переплавлена, позже — подарки и продажи.

-- 1. Новый вид записи в книге монет
alter table public.points_ledger drop constraint points_ledger_reason_check;
alter table public.points_ledger add constraint points_ledger_reason_check
  check (reason = any (array['question', 'fill', 'streak', 'game', 'poll', 'suggest', 'cards']));

-- 2. Таблицы. Напрямую закрыты — всё только через функции ниже.
create table public.card_series (
  id smallint primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table public.cards (
  id integer generated always as identity primary key,
  series_id smallint not null references public.card_series (id),
  code text not null unique,                 -- ключ рисунка в cards.js
  name text not null,
  rarity text not null check (rarity in ('common', 'uncommon', 'rare', 'epic', 'legendary')),
  copies smallint not null check (copies between 1 and 1000),
  sort smallint not null default 0
);

create table public.card_copies (
  id bigint generated always as identity primary key,
  card_id integer not null references public.cards (id),
  serial smallint not null,
  state text not null default 'deck' check (state in ('deck', 'owned', 'melted')),
  owner_id uuid references auth.users (id) on delete set null,
  obtained_at timestamptz,
  melted_at timestamptz,
  unique (card_id, serial)
);
create index card_copies_owner_idx on public.card_copies (owner_id) where state = 'owned';
create index card_copies_deck_idx on public.card_copies (card_id) where state = 'deck';

create table public.card_events (
  id bigint generated always as identity primary key,
  copy_id bigint not null references public.card_copies (id),
  kind text not null check (kind in ('open', 'melt', 'gift', 'sale')),
  from_user uuid references auth.users (id) on delete set null,
  to_user uuid references auth.users (id) on delete set null,
  price integer,
  created_at timestamptz not null default now()
);
create index card_events_copy_idx on public.card_events (copy_id, created_at);

create table public.card_showcase (
  user_id uuid not null references auth.users (id) on delete cascade,
  slot smallint not null check (slot between 1 and 3),
  copy_id bigint not null unique references public.card_copies (id),
  primary key (user_id, slot)
);

alter table public.card_series enable row level security;
alter table public.cards enable row level security;
alter table public.card_copies enable row level security;
alter table public.card_events enable row level security;
alter table public.card_showcase enable row level security;
revoke all on public.card_series, public.cards, public.card_copies, public.card_events, public.card_showcase from anon, authenticated;

-- 3. Серия «Начало»: 20 карточек и все 85 копий
insert into public.card_series (id, name) values (1, 'Начало');
insert into public.cards (series_id, code, name, rarity, copies, sort) values
  (1, 'coin',     'Монета',       'common', 6, 1),
  (1, 'fire',     'Огонёк',       'common', 6, 2),
  (1, 'question', 'Знак вопроса', 'common', 6, 3),
  (1, 'blank',    'Пропуск',      'common', 6, 4),
  (1, 'arrow',    'Стрелка',      'common', 6, 5),
  (1, 'ball',     'Шарик',        'common', 6, 6),
  (1, 'cress',    'Кресс-салат',  'common', 6, 7),
  (1, 'mine',     'Мина',         'common', 6, 8),
  (1, 'rocket',   'Ракета',       'uncommon', 4, 9),
  (1, 'bell',     'Колокольчик',  'uncommon', 4, 10),
  (1, 'cloud',    'Облачко',      'uncommon', 4, 11),
  (1, 'silver',   'Серебро',      'uncommon', 4, 12),
  (1, 'bronze',   'Бронза',       'uncommon', 4, 13),
  (1, 'trophy',   'Кубок',        'rare', 3, 14),
  (1, 'streak30', '30 дней',      'rare', 3, 15),
  (1, 'first',    'Первое место', 'rare', 3, 16),
  (1, 'x10',      '×10',          'rare', 3, 17),
  (1, 'ramp',     'Трамплин',     'epic', 2, 18),
  (1, 'reverse',  'Разворот',     'epic', 2, 19),
  (1, 'sun',      'Солнце дня',   'legendary', 1, 20);
insert into public.card_copies (card_id, serial)
  select c.id, s from public.cards c, generate_series(1, c.copies) s;

-- 4. Цена и переплавка по редкости (одно место, чтобы не разъехались)
create or replace function public.card_rank(p_rarity text)
returns integer language sql immutable set search_path to ''
as $function$
  select case p_rarity when 'common' then 1 when 'uncommon' then 2 when 'rare' then 3 when 'epic' then 4 when 'legendary' then 5 end
$function$;

create or replace function public.card_melt_value(p_rarity text)
returns integer language sql immutable set search_path to ''
as $function$
  select case p_rarity when 'common' then 15 when 'uncommon' then 30 when 'rare' then 60 when 'epic' then 150 end
$function$;

-- Цена открытия: по самой редкой карточке, которая ещё есть в колоде. Колода пуста — null.
create or replace function public.cards_price(p_series integer)
returns integer language sql stable security definer set search_path to ''
as $function$
  select case max(public.card_rank(c.rarity)) when 5 then 300 when 4 then 250 when 3 then 200 when 2 then 150 when 1 then 100 end
  from public.card_copies k join public.cards c on c.id = k.card_id
  where c.series_id = p_series and k.state = 'deck'
$function$;
revoke all on function public.card_rank(text), public.card_melt_value(text), public.cards_price(integer) from public, anon, authenticated;

-- 5. Состояние колоды: цена, сколько осталось всего и по редкостям
create or replace function public.cards_deck(p_series integer default 1)
returns table (series_name text, price integer, deck_left integer, deck_total integer,
               left_common integer, left_uncommon integer, left_rare integer, left_epic integer, left_legendary integer)
language sql stable security definer set search_path to ''
as $function$
  select s.name, public.cards_price(s.id),
    count(*) filter (where k.state = 'deck')::integer,
    count(*)::integer,
    count(*) filter (where k.state = 'deck' and c.rarity = 'common')::integer,
    count(*) filter (where k.state = 'deck' and c.rarity = 'uncommon')::integer,
    count(*) filter (where k.state = 'deck' and c.rarity = 'rare')::integer,
    count(*) filter (where k.state = 'deck' and c.rarity = 'epic')::integer,
    count(*) filter (where k.state = 'deck' and c.rarity = 'legendary')::integer
  from public.card_series s
  join public.cards c on c.series_id = s.id
  join public.card_copies k on k.card_id = c.id
  where s.id = p_series and public.is_member()
  group by s.id, s.name
$function$;
revoke all on function public.cards_deck(integer) from public, anon;
grant execute on function public.cards_deck(integer) to authenticated;

-- 6. Каталог серии: все карточки (для сетки и силуэтов)
create or replace function public.cards_catalog(p_series integer default 1)
returns table (card_id integer, code text, name text, rarity text, copies integer, sort integer, melt_value integer)
language sql stable security definer set search_path to ''
as $function$
  select c.id, c.code, c.name, c.rarity, c.copies::integer, c.sort::integer, public.card_melt_value(c.rarity)
  from public.cards c
  where c.series_id = p_series and public.is_member()
  order by c.sort
$function$;
revoke all on function public.cards_catalog(integer) from public, anon;
grant execute on function public.cards_catalog(integer) to authenticated;

-- 7. Мои карточки (каждая копия отдельно) и на какой полке витрины она стоит
create or replace function public.cards_my()
returns table (copy_id bigint, card_id integer, serial integer, obtained_at timestamptz, slot integer, can_melt boolean)
language sql stable security definer set search_path to ''
as $function$
  select k.id, k.card_id, k.serial::integer, k.obtained_at, sc.slot::integer,
         public.card_melt_value(c.rarity) is not null and sc.slot is null
           and (select count(*) from public.card_copies x where x.card_id = k.card_id and x.state <> 'melted') > 1
  from public.card_copies k
  join public.cards c on c.id = k.card_id
  left join public.card_showcase sc on sc.copy_id = k.id
  where k.owner_id = auth.uid() and k.state = 'owned' and public.is_member()
  order by c.sort, k.serial
$function$;
revoke all on function public.cards_my() from public, anon;
grant execute on function public.cards_my() to authenticated;

-- 8. Открыть карточку. p_price — цена, которую видел человек: если она уже другая, ничего не списываем.
--    Очередь 'points:<id>' — та же, что у казино: два быстрых нажатия не уведут баланс в минус.
--    Очередь колоды — чтобы двое одновременно не получили одну и ту же копию.
create or replace function public.cards_open(p_series integer, p_price integer)
returns table (copy_id bigint, card_id integer, code text, name text, rarity text, serial integer, copies integer,
               balance numeric, next_price integer, deck_left integer)
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  cur integer;
  cid bigint;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  perform pg_advisory_xact_lock(hashtext('points:' || uid::text));
  perform pg_advisory_xact_lock(hashtext('cards:deck:' || p_series::text));
  cur := public.cards_price(p_series);
  if cur is null then raise exception 'cards_deck_empty'; end if;
  if p_price is distinct from cur then raise exception 'cards_price_changed'; end if;
  if public.coins_of(uid) < cur then raise exception 'cards_not_enough'; end if;

  select k.id into cid
  from public.card_copies k join public.cards c on c.id = k.card_id
  where c.series_id = p_series and k.state = 'deck'
  order by random()
  limit 1;

  update public.card_copies k set state = 'owned', owner_id = uid, obtained_at = now() where k.id = cid;
  insert into public.points_ledger (user_id, amount, reason, ref) values (uid, -cur, 'cards', 'open:' || cid);
  insert into public.card_events (copy_id, kind, to_user, price) values (cid, 'open', uid, cur);

  return query
    select k.id, c.id, c.code, c.name, c.rarity, k.serial::integer, c.copies::integer,
           public.coins_of(uid), public.cards_price(p_series),
           (select count(*)::integer from public.card_copies x join public.cards y on y.id = x.card_id
             where y.series_id = p_series and x.state = 'deck')
    from public.card_copies k join public.cards c on c.id = k.card_id
    where k.id = cid;
end $function$;
revoke all on function public.cards_open(integer, integer) from public, anon;
grant execute on function public.cards_open(integer, integer) to authenticated;

-- 9. Переплавить копию. Строка карточки блокируется (for update), чтобы двое не переплавили
--    две последние копии одновременно и не оставили ноль.
create or replace function public.cards_melt(p_copy bigint)
returns table (value integer, balance numeric)
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  k public.card_copies%rowtype;
  cid integer;
  r text;
  v integer;
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  select x.card_id into cid from public.card_copies x where x.id = p_copy;
  if not found then raise exception 'cards_not_yours'; end if;
  -- сначала карточка, потом сама копия: так два одновременных нажатия идут по очереди
  select c.rarity into r from public.cards c where c.id = cid for update;
  select * into k from public.card_copies x where x.id = p_copy for update;
  if k.owner_id is distinct from uid or k.state <> 'owned' then raise exception 'cards_not_yours'; end if;
  v := public.card_melt_value(r);
  if v is null then raise exception 'cards_no_melt'; end if;
  if exists (select 1 from public.card_showcase sc where sc.copy_id = p_copy) then raise exception 'cards_in_showcase'; end if;
  if (select count(*) from public.card_copies x where x.card_id = k.card_id and x.state <> 'melted') <= 1 then
    raise exception 'cards_last_copy';
  end if;
  perform pg_advisory_xact_lock(hashtext('points:' || uid::text));
  update public.card_copies x set state = 'melted', melted_at = now() where x.id = p_copy;
  insert into public.points_ledger (user_id, amount, reason, ref) values (uid, v, 'cards', 'melt:' || p_copy);
  insert into public.card_events (copy_id, kind, from_user, price) values (p_copy, 'melt', uid, v);
  return query select v, public.coins_of(uid);
end $function$;
revoke all on function public.cards_melt(bigint) from public, anon;
grant execute on function public.cards_melt(bigint) to authenticated;

-- 10. Витрина: поставить копию на полку 1–3 (null — убрать). Если копия уже на другой полке — переедет.
create or replace function public.cards_set_showcase(p_slot integer, p_copy bigint)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
begin
  if not public.is_member() then raise exception 'not_member'; end if;
  if p_slot is null or p_slot not between 1 and 3 then raise exception 'cards_bad_slot'; end if;
  if p_copy is not null and not exists (select 1 from public.card_copies x where x.id = p_copy and x.owner_id = uid and x.state = 'owned') then
    raise exception 'cards_not_yours';
  end if;
  delete from public.card_showcase sc where sc.user_id = uid and (sc.slot = p_slot or sc.copy_id = p_copy);
  if p_copy is not null then
    insert into public.card_showcase (user_id, slot, copy_id) values (uid, p_slot, p_copy);
  end if;
end $function$;
revoke all on function public.cards_set_showcase(integer, bigint) from public, anon;
grant execute on function public.cards_set_showcase(integer, bigint) to authenticated;

-- 11. Витрины всех участников и сколько разных карточек собрал каждый (для таблицы «Участники»)
create or replace function public.cards_showcases()
returns table (user_id uuid, slot integer, copy_id bigint, card_id integer, serial integer)
language sql stable security definer set search_path to ''
as $function$
  select sc.user_id, sc.slot::integer, k.id, k.card_id, k.serial::integer
  from public.card_showcase sc join public.card_copies k on k.id = sc.copy_id
  where public.is_member() and k.state = 'owned' and k.owner_id = sc.user_id
  order by sc.user_id, sc.slot
$function$;
revoke all on function public.cards_showcases() from public, anon;
grant execute on function public.cards_showcases() to authenticated;

create or replace function public.cards_members()
returns table (user_id uuid, distinct_cards integer, total_copies integer)
language sql stable security definer set search_path to ''
as $function$
  select k.owner_id, count(distinct k.card_id)::integer, count(*)::integer
  from public.card_copies k
  where k.state = 'owned' and k.owner_id is not null and public.is_member()
  group by k.owner_id
$function$;
revoke all on function public.cards_members() from public, anon;
grant execute on function public.cards_members() to authenticated;

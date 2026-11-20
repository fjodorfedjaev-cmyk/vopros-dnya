-- Для проверки «Коллекции» локально: таблица auth.users (на неё ссылаются карточки и лавка) с теми же участниками,
-- и убираем заглушку card_listings — настоящую создаст миграция лавки.
-- Порядок: ./db.sh ИМЯ cards-stub.sql ../../supabase/cards/01_cards.sql ../../supabase/market/01_market.sql …
create table if not exists auth.users (id uuid primary key);
insert into auth.users select id from public.profiles on conflict do nothing;
drop table if exists public.card_listings;
-- лавка заодно ставит уведомление о «Своём вопросе» — нужна заглушка таблицы предложений
create table if not exists public.suggestions (id bigint generated always as identity primary key, user_id uuid, kind text, text text, status text default 'pending');

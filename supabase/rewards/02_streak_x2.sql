-- Бонусы за серию дней ×2: 3 дня — 40, 7 — 100, 30 — 300, 100 — 1000 (было 20/50/150/500).
-- Срабатывает только при новых ответах (триггер AFTER INSERT на answers), прошлые не пересчитываются.
-- Награда за сам ответ остаётся 30.

create or replace function public.award_answer_points()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
declare s integer; bonus integer;
begin
  insert into public.points_ledger (user_id, amount, reason, ref, day)
  values (new.user_id, 30, new.kind, new.day::text, new.day)
  on conflict do nothing;
  if (select count(*) from public.answers a where a.user_id = new.user_id and a.day = new.day) = 1 then
    s := public.streak_on(new.user_id, new.day);
    bonus := case s when 3 then 40 when 7 then 100 when 30 then 300 when 100 then 1000 else 0 end;
    if bonus > 0 then
      insert into public.points_ledger (user_id, amount, reason, ref, day)
      values (new.user_id, bonus, 'streak', s || ':' || new.day, new.day)
      on conflict do nothing;
    end if;
  end if;
  return new;
end $function$;

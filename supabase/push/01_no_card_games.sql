-- УВЕДОМЛЕНИЯ: карточные игры больше не шлют push (21.11.2026).
-- Дурак (новая комната — всем, «Дурак начинается, жми Готов» — тем, кто в комнате; «Ещё раз» — тоже новая комната)
-- и Покер (новый стол) — никому. Остальные уведомления (напоминание, комментарии, Лавка, «Свой вопрос», дуэли) — как были.
-- Отсекается в одном месте — в push_call, через которую база зовёт функцию push: игры могут звать её как раньше.
create or replace function public.push_call(p_payload jsonb)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare s text;
begin
  -- карточные игры уведомлений не шлют (решение 21.11: было много одинаковых «Новая комната»)
  if p_payload ->> 'type' in ('durak', 'poker') then return; end if;
  s := public.push_hook_secret();
  if s is null then return; end if;
  perform net.http_post(
    url := 'https://zbjhayjnxlvmpzxpiktg.supabase.co/functions/v1/push',
    body := p_payload,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', s),
    timeout_milliseconds := 10000
  );
end $function$;

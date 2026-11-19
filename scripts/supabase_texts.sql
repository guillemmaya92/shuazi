-- ── Texts (graded reading passages) ──────────────────────────────────────────
-- Run once in the Supabase SQL editor (Dashboard → SQL). Safe to re-run:
-- tables/policies are created only if missing, and the seed is inserted only if a text
-- with the same title and level does not exist yet.
--
-- `text` holds the passage already segmented: "|" marks word boundaries and a
-- blank line separates paragraphs. Generate it with scripts/segment_text.py.
-- `text_en` / `text_es` are the translations, with the same paragraph breaks.

-- ── texts ────────────────────────────────────────────────────────────────────
create table if not exists public.texts (
  id         integer generated always as identity primary key,
  title      text        not null,                 -- Chinese title
  title_en   text,
  title_es   text,
  hsk        smallint    not null check (hsk between 1 and 7),
  position   numeric(6,3) not null default 0,      -- order within its HSK level (11.2 = lesson 11, part 2)
  text       text        not null,                 -- "|"-segmented, paragraphs split by blank line
  text_en    text,                                 -- English translation
  text_es    text,                                 -- Spanish translation
  source     text,
  audio_url  text,
  published  boolean     not null default true,
  created_at timestamptz not null default now()
  -- hsk and position are free: no UNIQUE (hsk, position). Order is by hsk, position, id.
);

create index if not exists texts_hsk_pos_idx on public.texts (hsk, position);

alter table public.texts enable row level security;

-- Public read (like words/chars); no client writes — edit from the dashboard.
drop policy if exists "texts public read" on public.texts;
create policy "texts public read"
  on public.texts for select
  to anon, authenticated
  using (published);

-- ── text_progress (optional: mark texts as read) ─────────────────────────────
create table if not exists public.text_progress (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  text_id    integer     not null references public.texts(id) on delete cascade,
  state      text        not null default 'read' check (state in ('read', 'review')),
  updated_at timestamptz not null default now(),
  primary key (user_id, text_id)
);

alter table public.text_progress enable row level security;

drop policy if exists "own read"   on public.text_progress;
drop policy if exists "own insert" on public.text_progress;
drop policy if exists "own update" on public.text_progress;
drop policy if exists "own delete" on public.text_progress;
create policy "own read"   on public.text_progress for select to authenticated using (auth.uid() = user_id);
create policy "own insert" on public.text_progress for insert to authenticated with check (auth.uid() = user_id);
create policy "own update" on public.text_progress for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own delete" on public.text_progress for delete to authenticated using (auth.uid() = user_id);

-- ── Seed: 一、我喜欢“快” (HSK 2) ──────────────────────────────────────────────
insert into public.texts (title, title_en, title_es, hsk, position, text, text_en, text_es)
select v.* from (values (
  '一、我喜欢“快”',
  '1. I Like “Fast”',
  '1. Me gusta “rápido”',
  2,
  1,
  -- text (Chinese, segmented)
  $zh$我|叫|小电|，|我|是|一|个|电脑|。|我|的|主人|叫|大晴|，|她|今年|27|岁|。

我们|住|在|北京|，|北京|很|大|。|这里|有|很|多|房子|，|很|多|车|，|很|多|人|。|每|个人|都|很|忙|，|每|个人|做|事|都|很|快|。

大晴|每|天|很|早|起床|。|她|很|快|地|吃|早饭|，|然后|很|快|地|喝|一|杯|咖啡|。

大晴|的|工作|很|忙|，|她|每|天|用|我|做|很|多|事|：|做|图|、|写|东西|、|开会|。|她|经常|说|：|“|小电|，|快点儿|，|快点儿|！|我们|要|再|快点儿|！|”

我|觉得|“|快|”|是|一|件|好事|。|主人|工作|快|，|就|能|做|更|多|的|事|，|就|能|有|更|多|的|钱|。|我|喜欢|帮助|主人|工作|，|我|喜欢|“|快|”|。

每|天|早上|，|我|和|主人|坐|地铁|去|公司|。|北京|的|地铁|里|有|很|多|很|多|人|，|大晴|经常|站|着|，|她|看|手机|。|地铁|里|的|人|都|不|说话|，|有的|人|睡觉|，|有的|人|看|手机|，|他们|的|脸|上|没有|笑|。

到|了|公司|，|大晴|就|开始|工作|了|。|她|的|手|在|我|的|身上|飞|快|地|打|字|，|她|一会儿|打开|很|多|东西|，|一会儿|很|快|地|关上|。$zh$,
  -- text_en
  $en$My name is Xiaodian, and I am a computer. My owner is called Daqing; she is 27 years old this year.

We live in Beijing. Beijing is very big. There are many houses, many cars and many people here. Everyone is very busy, and everyone does things very fast.

Daqing gets up very early every day. She eats breakfast very quickly, and then drinks a cup of coffee very quickly.

Daqing's work is very busy. Every day she uses me to do many things: making graphics, writing, and holding meetings. She often says: “Xiaodian, hurry up, hurry up! We need to be even faster!”

I think “fast” is a good thing. When my owner works fast, she can get more done and earn more money. I like helping my owner work, and I like “fast”.

Every morning, my owner and I take the subway to the company. There are lots and lots of people on Beijing's subway. Daqing often stands, looking at her phone. People on the subway don't talk: some sleep, some look at their phones, and there are no smiles on their faces.

When we get to the company, Daqing starts working. Her hands fly over my body as she types; one moment she opens lots of things, the next she closes them again very quickly.$en$,
  -- text_es
  $es$Me llamo Xiaodian y soy un ordenador. Mi dueña se llama Daqing y este año tiene 27 años.

Vivimos en Pekín. Pekín es muy grande. Aquí hay muchas casas, muchos coches y mucha gente. Todo el mundo está muy ocupado y todo el mundo hace las cosas muy rápido.

Daqing se levanta muy temprano todos los días. Desayuna muy rápido y luego se toma un café muy rápido.

El trabajo de Daqing es muy ajetreado. Cada día me usa para hacer muchas cosas: hacer imágenes, escribir y asistir a reuniones. Dice a menudo: “Xiaodian, ¡rápido, rápido! ¡Tenemos que ir aún más rápido!”

Creo que “rápido” es algo bueno. Si mi dueña trabaja rápido, puede hacer más cosas y ganar más dinero. Me gusta ayudar a mi dueña a trabajar y me gusta “rápido”.

Todas las mañanas, mi dueña y yo vamos a la empresa en metro. En el metro de Pekín hay muchísima gente. Daqing suele ir de pie, mirando el móvil. Nadie en el metro habla: unos duermen, otros miran el móvil, y en sus caras no hay sonrisas.

Al llegar a la empresa, Daqing empieza a trabajar. Sus manos vuelan sobre mi cuerpo al escribir; en un momento abre muchas cosas y al siguiente las cierra muy rápido.$es$
)) as v(title, title_en, title_es, hsk, position, text, text_en, text_es)
where not exists (select 1 from public.texts x where x.title = v.title and x.hsk = v.hsk);

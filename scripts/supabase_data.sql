-- =============================================================
-- Run this in the Supabase SQL Editor BEFORE migrating data.
-- =============================================================

-- Drop in reverse FK order
drop table if exists word_phrase    cascade;
drop table if exists char_word      cascade;
drop table if exists component_char cascade;
drop table if exists phrases        cascade;
drop table if exists words          cascade;
drop table if exists chars          cascade;
drop table if exists radicals       cascade;
drop table if exists components     cascade;
drop table if exists slang    		cascade;

-- Truncate
truncate table
  word_phrase,
  char_word,
  component_char,
  phrases
  words,
  chars,
  radicals,
  components,
  slang
RESTART identity
cascade;

-- Disable
alter table components     disable row level security;
alter table radicals       disable row level security;
alter table chars          disable row level security;
alter table words          disable row level security;
alter table phrases        disable row level security;
alter table component_char disable row level security;
alter table char_word      disable row level security;
alter table word_phrase    disable row level security;
alter table slang      	   disable row level security;

-- Enable
alter table components     enable row level security;
alter table radicals       enable row level security;
alter table chars          enable row level security;
alter table words          enable row level security;
alter table phrases        enable row level security;
alter table component_char enable row level security;
alter table char_word      enable row level security;
alter table word_phrase    enable row level security;
alter table slang          enable row level security;

-- Policy
create policy "public read" on components     		for select to anon, authenticated using (true);
create policy "public read" on radicals    			for select to anon, authenticated using (true);
create policy "public read" on chars  				for select to anon, authenticated using (true);
create policy "public read" on words     			for select to anon, authenticated using (true);
create policy "public read" on phrases     			for select to anon, authenticated using (true);
create policy "public read" on word_phrase 			for select to anon, authenticated using (true);
create policy "public read" on char_word 			for select to anon, authenticated using (true);
create policy "public read" on component_char 		for select to anon, authenticated using (true);
create policy "public read" on slang 				for select to anon, authenticated using (true);

-- Index
create index if not exists component_char_id_component_idx on component_char (id_component);
create index if not exists component_char_id_char_idx on component_char (id_char);

create index if not exists char_word_id_char_idx on char_word (id_char);
create index if not exists char_word_id_word_idx on char_word (id_word);

create index if not exists word_phrase_id_word_idx on word_phrase (id_word);
create index if not exists word_phrase_id_phrase_idx on word_phrase (id_phrase);

create table components (
    id          int primary key,
    component   text not null,
    pinyin      text,
    meaning     text,
    stroke      int,
    productive  int,
    coverage    decimal(18,2)
);

create table radicals (
    id          int primary key,
    radical     text not null unique,
    traditional text,
    pinyin      text,
    meaning     text,
    stroke      int,
    productive  int,
    coverage    decimal(18,2)
);

create table chars (
    id          int primary key,
    char        text not null,
    pinyin      text,
    meaning     text,
    radical     text references radicals(radical),
    hsk         int,
    stroke      int,
    productive  int,
    coverage    int,
    frequency   decimal(18,2)
);

create table words (
    id          int primary key,
    word        text not null,
    pinyin      text,
    meaning     text,
    hsk         int
);

create table phrases (
    id          int primary key,
    phrase      text not null,
    pinyin      text,
    meaning     text,
    "count"     int
);

create table slang (
    id      int primary key,
    slang   text,
    pinyin  text,
    literal text,
    meaning text,
    origin  text,
    image   text
);

create table component_char (
    id_component  int not null references components(id),
    id_char       int not null references chars(id),
    primary key (id_component, id_char)
);

create table char_word (
    id_char  int not null references chars(id),
    id_word  int not null references words(id),
    primary key (id_char, id_word)
);

create table word_phrase (
    id_word  int not null references words(id),
    id_phrase  int not null references phrases(id),
    primary key (id_word, id_phrase)
);
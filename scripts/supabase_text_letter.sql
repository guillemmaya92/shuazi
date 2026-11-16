-- ── Seed: 给刘老师的信 (HSK 4) ────────────────────────────────────────────────
-- Run in the Supabase SQL editor after scripts/supabase_texts.sql. Safe to re-run:
-- it upserts by (hsk, position). Change `hsk` / `position` below if you want it
-- listed under another level or in another order.

insert into public.texts (title, title_en, title_es, hsk, position, text, text_en, text_es)
values (
  '给刘老师的信',
  'A Letter to Teacher Liu',
  'Una carta para el profesor Liu',
  4,
  1,
  -- text (Chinese, segmented)
  $zh$刘|老师|：

您|好|！

您|的|信|我|收到|了|，|但是|因为|忙|，|也|因为|我|的|汉语|不|好|，|过|了|这么|久|才|给|您|写|信|，|请|您|原谅|。|您|一切|都|好|吧|？

转眼|我|到|中国|已经|半年|多|了|。|去年|9|月|刚|来|中国|时|，|我|听|不|懂|也|看|不|懂|，|也|没有|朋友|，|非常|难过|。|现在|我|的|汉语|水平|有|了|一定|程度|的|提高|，|也|交|了|不少|朋友|，|不但|有|中国|的|，|而且|还有|世界|各地|的|，|我们|一起|学习|，|互相|帮助|，|每|天|都|过|得|很|开心|。|汉语|学习|也|越来越|有意思|了|。

开始|上课|时|，|我|不|习惯|老师|说|汉语|，|只能|听|懂|百|分之|四|五|十|，|因为|我|没|学|过|简化|字|，|有|很|多|字|不|认识|。|但是|我|每|天|努力|学习|，|不|懂|就|问|老师|和|同学|，|所以|我|的|进步|很|快|。|现在|我|已经|能|用|汉语|进行|一般|的|会|话|了|，|上课|也|能|听|懂|四|分之|三|了|，|还|能|用|汉语|写|一|篇|不错|的|作文|了|。|最|重要|的|是|，|我|越来越|喜欢|汉语|了|，|我|想|将来|找|一|个|和|中国|有关|系|的|工作|。

我|现在|的|生活|也|基本|没|问题|了|。|刚|来|时|我|不|习惯|吃|中国|菜|，|觉得|油|太|多|，|也|看|不|懂|菜单|，|只好|常常|去|吃|麦当劳|。|现在|我|不但|习惯|了|吃|中餐|，|还|会|做|几|个|地道|的|中国|菜|呢|。|等|我|回去|以后|一定|做|给|你们|吃|。

我|以前|打算|今年|8|月|回国|，|但是|我|现在|决定|延长|一|年|，|到|明年|8|月|再|回国|。|在|这|一|年|里|，|我|想|多|了解|一点儿|中国|文化|，|多|交|一些|朋友|。

老师|，|您|的|工作|顺利|吗|？|祝|您|身体|健康|！

您|的|学生|：|玛丽

4|月|10|日$zh$,
  -- text_en
  $en$Teacher Liu:

Hello!

I received your letter, but because I was busy, and also because my Chinese is not good, it has taken me this long to write back. Please forgive me. Is everything going well with you?

In the blink of an eye, I have already been in China for more than half a year. When I first arrived in China last September, I couldn't understand what I heard or read, and I had no friends, so I was very sad. Now my Chinese has improved to a certain degree, and I have made quite a few friends, not only Chinese ones, but also ones from all over the world. We study together and help each other, and I have a very happy time every day. Studying Chinese is becoming more and more interesting.

When classes started, I wasn't used to the teacher speaking Chinese and could only understand forty or fifty percent, because I hadn't studied simplified characters and there were many characters I didn't recognize. But I studied hard every day, and when I didn't understand I asked my teacher and classmates, so I made fast progress. Now I can already hold general conversations in Chinese, I can understand three quarters of what is said in class, and I can even write a decent composition in Chinese. Most importantly, I like Chinese more and more, and I want to find a job related to China in the future.

My life now is basically fine too. When I first came, I wasn't used to eating Chinese food; I thought it was too oily, and I couldn't read the menus either, so I often had no choice but to eat at McDonald's. Now not only am I used to eating Chinese food, I can even cook a few authentic Chinese dishes! When I go back, I will definitely cook them for you all.

I used to plan to return home this August, but now I have decided to extend my stay by a year and go back next August. In this year, I want to learn a bit more about Chinese culture and make more friends.

Teacher, is your work going smoothly? I wish you good health!

Your student: Mary

April 10$en$,
  -- text_es
  $es$Profesor Liu:

¡Hola!

Recibí su carta, pero como estaba ocupada y además mi chino no es bueno, he tardado tanto en escribirle. Le ruego que me disculpe. ¿Está usted bien?

En un abrir y cerrar de ojos ya llevo más de medio año en China. Cuando llegué el pasado septiembre, no entendía lo que oía ni lo que leía, no tenía amigos y estaba muy triste. Ahora mi nivel de chino ha mejorado hasta cierto punto y he hecho bastantes amigos, no solo chinos, sino también de todas partes del mundo. Estudiamos juntos, nos ayudamos unos a otros y cada día lo paso muy bien. Estudiar chino es cada vez más interesante.

Al empezar las clases, no estaba acostumbrada a que el profesor hablara en chino y solo entendía entre el cuarenta y el cincuenta por ciento, porque no había estudiado los caracteres simplificados y había muchos que no reconocía. Pero estudié con esfuerzo cada día y, cuando no entendía, preguntaba al profesor y a mis compañeros, así que progresé rápido. Ahora ya puedo mantener conversaciones generales en chino, en clase entiendo tres cuartas partes y hasta puedo escribir una redacción decente. Lo más importante es que cada vez me gusta más el chino y quiero encontrar en el futuro un trabajo relacionado con China.

Mi vida actual también está básicamente bien. Al llegar no me acostumbraba a la comida china; me parecía que tenía demasiado aceite y tampoco entendía los menús, así que no me quedaba más remedio que comer a menudo en McDonald's. Ahora no solo me he acostumbrado a la comida china, ¡sino que sé preparar varios platos auténticos! Cuando vuelva, seguro que os los cocino.

Antes pensaba volver a mi país este agosto, pero ahora he decidido prolongar mi estancia un año y regresar el próximo agosto. Durante este año quiero conocer un poco más la cultura china y hacer más amigos.

Profesor, ¿le va bien el trabajo? ¡Le deseo buena salud!

Su alumna: Mary

10 de abril$es$
)
on conflict (hsk, position) do update
  set title    = excluded.title,
      title_en = excluded.title_en,
      title_es = excluded.title_es,
      text     = excluded.text,
      text_en  = excluded.text_en,
      text_es  = excluded.text_es;

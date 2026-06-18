import asyncio
import aiohttp
import pandas as pd
import os

chars = ["一", "人", "大", "卜", "心", "子", "宀", "豕", "丿", "十", "㇗", "丨", "厶", "自", "木", "丷", "𠂇", "月", "生", "日", "寸", "彳", "辶", "八", "刀", "丶", "又", "走", "己", "亻", "门", "⺊", "廾", "文", "忄", "青", "㇆", "戈", "㇇", "立", "小", "斤", "女", "乚", "亅", "口", "出", "艹", "犭", "犬", "至", "刂", "灬", "王", "见", "土", "力", "⺀", "手", "回", "龰", "无", "二", "㇒", "几", "首", "亠", "厂", "⺁", "音", "面", "⺺", "羊", "气", "老", "爫", "冖", "⺍", "广", "廿", "龵", "目", "囗", "玉", "氵", "殳", "身", "纟", "龴", "工", "覀", "士", "巾", "干", "舌", "⺈", "矢", "田", "行", "欠", "讠", "止", "夕", "车", "耳", "龶", "方", "礻", "片", "水", "里", "色", "长", "多", "阝", "冂", "儿", "言", "西", "尢", "母", "高", "匸", "匕", "夂", "扌", "金", "⺙", "龙", "戶", "甘", "示", "风", "山", "用", "品", "牛", "勹", "白", "禾", "㇎", "⺌", "㇙", "⺧", "朋", "艮", "⺮", "弓", "从", "火", "入", "巳", "马", "米", "彐", "页", "㇝", "彡", "曰", "⻊", "隹", "匚", "乂", "穴", "卩", "非", "角", "谷", "耂", "㇏", "㇖", "弋", "州", "㇂", "丬", "已", "户", "玨", "尸", "歹", "㇈", "钅", "酉", "网", "虫", "㠯", "饣", "北", "凵", "衣", "氺", "皿", "贝", "比", "氏", "支", "㇠", "食", "皮", "禸", "疒", "𢛳", "而", "戋", "㇉", "川", "香", "雨", "⺳", "飞", "韦", "疋", "哥", "石", "黑", "冫", "糸", "廴", "聿", "血", "麻", "足", "衤", "㗊", "癶", "豆", "卯", "林", "歺", "隶", "肉", "毛", "骨", "斗", "罒", "⺕", "鬼", "父", "鱼", "乑", "鸟", "兵", "炎", "舟", "釆", "吕", "镸", "牙", "昌", "舛", "辛", "爿", "臣", "圭", "众", "双", "革", "瓜", "辰", "羽", "耒", "虍", "幺", "彑", "缶", "弱", "齐", "旡", "屮", "爪", "森", "㚘", "鼓", "臼", "麦", "兟", "吅", "鬲", "串", "鼻", "辡", "齿", "册", "竹", "豸", "𢆶", "鼠", "瓦", "攴", "㸚", "⺪", "矛", "乙", "弜"]

CONCURRENCY = 50  # peticiones simultáneas máximas

def clean(text):
    return text.split("/")[0].split("[")[0]

async def fetch_char(session, semaphore, char):
    async with semaphore:
        url = f"https://hanzicraft.com/api/character/{char}"
        async with session.get(url) as resp:
            data = await resp.json(content_type=None)

    radicalmeanings = data["radicalmeanings"][char]

    rows = []
    for simplified, definition in radicalmeanings.items():
        rows.append({
            "hanzi": char,
            "simplified": simplified,
            "definition": clean(definition),
        })
    return rows

async def main():
    semaphore = asyncio.Semaphore(CONCURRENCY)
    connector = aiohttp.TCPConnector(limit=CONCURRENCY)

    async with aiohttp.ClientSession(connector=connector) as session:
        tasks = [fetch_char(session, semaphore, char) for char in chars]
        results = await asyncio.gather(*tasks, return_exceptions=True)

    all_rows = []
    errors = []
    for char, result in zip(chars, results):
        if isinstance(result, Exception):
            errors.append((char, result))
        else:
            all_rows.extend(result)

    if errors:
        print(f"⚠️  {len(errors)} errores:")
        for char, err in errors:
            print(f"  {char}: {err}")

    df = pd.DataFrame(all_rows, columns=[
        "hanzi", "simplified", "definition"
    ])

    script_dir = os.path.dirname(os.path.abspath(__file__))
    output_path = os.path.join(script_dir, "hanzi_components.xlsx")
    df.to_excel(output_path, index=False)
    print(f"✅ Archivo guardado en: {output_path} ({len(df)} filas)")

if __name__ == "__main__":
    asyncio.run(main())
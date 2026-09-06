"""Collect current ATP/WTA singles schedules and results from ESPN scoreboards."""

from __future__ import annotations

import json
import re
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
from urllib.parse import urlencode

TIMEZONE = ZoneInfo("Asia/Shanghai")
SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/tennis/{tour}/scoreboard?dates={date}"
HEADERS = {"Accept": "*/*", "User-Agent": "curl/8.7.1"}
NAME_CACHE = Path(".cache/player-names-zh.json")
MANUAL_NAMES = {
    "Alexander Bublik": "亚历山大·布勃利克",
    "Amanda Anisimova": "阿曼达·阿尼西莫娃",
    "Aryna Sabalenka": "阿丽娜·萨巴伦卡",
    "Benjamin Bonzi": "本雅明·邦齐",
    "Carlos Alcaraz": "卡洛斯·阿尔卡拉斯",
    "Coco Gauff": "科科·高芙",
    "Fiona Ferro": "菲奥娜·费罗",
    "Iga Swiatek": "伊加·斯维亚特克",
    "Michael Zheng": "郑瑞",
    "Mirra Andreeva": "米拉·安德烈耶娃",
    "Naomi Osaka": "大坂直美",
    "Rebeka Masarova": "雷贝卡·马萨洛娃",
    "Sorana Cirstea": "索拉娜·科斯蒂亚",
    "Stefanos Tsitsipas": "斯特凡诺斯·西西帕斯",
    "Tommy Paul": "汤米·保罗",
    "Valentin Vacherot": "瓦朗坦·瓦舍罗",
    "Zheng Qinwen": "郑钦文",
}


def get_json(item):
    requested_tour, url = item
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=30) as response:
        return requested_tour, json.load(response)


def country_code(competitor):
    href = competitor.get("athlete", {}).get("flag", {}).get("href", "")
    match = re.search(r"/([a-z]{3})\.png(?:\?|$)", href, re.IGNORECASE)
    return match.group(1).upper() if match else None


def status_name(competition):
    status = competition.get("status", {}).get("type", {})
    description = status.get("description", "").lower()
    if status.get("state") == "post" or status.get("completed"):
        return "finished"
    if "cancel" in description or "abandon" in description:
        return "cancelled"
    if "postpon" in description or "suspend" in description:
        return "postponed"
    return "scheduled"


def score_data(players):
    maximum = max((len(player.get("linescores", [])) for player in players), default=0)
    sets = []
    for index in range(maximum):
        values = []
        for player in players:
            lines = player.get("linescores", [])
            value = lines[index].get("value") if index < len(lines) else None
            values.append(int(value) if isinstance(value, (int, float)) else None)
        if values[0] is not None and values[1] is not None:
            sets.append({"p1": values[0], "p2": values[1]})
    score = " ".join(f"{item['p1']}-{item['p2']}" for item in sets) or None
    return score, sets


def source_link(event):
    for link in event.get("links", []):
        if "summary" in link.get("rel", []):
            return link.get("href")
    return "https://www.espn.com/tennis/scoreboard"


def wikidata_names(names):
    values = " ".join(f"{json.dumps(name)}@en" for name in names)
    query = (
        "SELECT ?name ?zh WHERE { VALUES ?name { " + values + " } "
        "{ ?item <http://www.w3.org/2000/01/rdf-schema#label> ?name } UNION "
        "{ ?item <http://www.w3.org/2004/02/skos/core#altLabel> ?name } "
        "?item <http://www.wikidata.org/prop/direct/P106> <http://www.wikidata.org/entity/Q10833314>. "
        "?item <http://www.w3.org/2000/01/rdf-schema#label> ?zh. "
        'FILTER(LANG(?zh)="zh-cn" || LANG(?zh)="zh-hans" || LANG(?zh)="zh") }'
    )
    body = urlencode({"query": query, "format": "json"}).encode()
    request = urllib.request.Request(
        "https://query.wikidata.org/sparql",
        data=body,
        headers={"Accept": "application/sparql-results+json", "User-Agent": "TennisFlow/0.3 (C2015/tennis-flow)"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            bindings = json.load(response).get("results", {}).get("bindings", [])
    except Exception as error:
        print(f"Wikidata batch lookup skipped: {error}")
        return {}
    translated = {}
    language_priority = {"zh": 1, "zh-hans": 2, "zh-cn": 3}
    for binding in bindings:
        name = binding.get("name", {}).get("value")
        label = binding.get("zh", {}).get("value")
        language = binding.get("zh", {}).get("xml:lang", "zh")
        if not name or not label:
            continue
        previous = translated.get(name)
        if not previous or language_priority.get(language, 0) > previous[0]:
            translated[name] = (language_priority.get(language, 0), label)
    return {name: value[1] for name, value in translated.items()}


def enrich_chinese_names(matches):
    cache = {}
    if NAME_CACHE.exists():
        try:
            cache = json.loads(NAME_CACHE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            cache = {}
    names = sorted({player["name"] for match in matches for player in match["players"]})
    cache.update(MANUAL_NAMES)
    unknown = [name for name in names if not cache.get(name)]
    if unknown:
        for start in range(0, len(unknown), 45):
            cache.update(wikidata_names(unknown[start:start + 45]))
        for name in unknown:
            cache.setdefault(name, None)
        NAME_CACHE.parent.mkdir(parents=True, exist_ok=True)
        NAME_CACHE.write_text(json.dumps(cache, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    for match in matches:
        for player in match["players"]:
            player["nameZh"] = cache.get(player["name"])
    return sum(bool(cache.get(name)) for name in names), len(names)


def normalize(payload, start_date, end_date, requested_tour):
    matches = {}
    for event in payload.get("events", []):
        event_name = event.get("name") or event.get("shortName") or "Tennis"
        venue_name = event.get("venue", {}).get("displayName") or ""
        city, _, country = venue_name.partition(",")
        for group in event.get("groupings", []):
            slug = group.get("grouping", {}).get("slug")
            if slug not in ("mens-singles", "womens-singles"):
                continue
            tour = "ATP" if slug == "mens-singles" else "WTA"
            if tour != requested_tour:
                continue
            draw_name = "男单" if tour == "ATP" else "女单"
            for competition in group.get("competitions", []):
                competition_id = str(competition.get("id") or "")
                competitors = sorted(competition.get("competitors", []), key=lambda item: item.get("order", 99))
                if not competition_id or len(competitors) != 2:
                    continue
                try:
                    local_start = datetime.fromisoformat(competition["date"].replace("Z", "+00:00")).astimezone(TIMEZONE)
                except (KeyError, ValueError):
                    continue
                if not start_date <= local_start.date() <= end_date:
                    continue

                players = []
                for index, competitor in enumerate(competitors):
                    athlete = competitor.get("athlete", {})
                    name = athlete.get("displayName") or athlete.get("fullName") or "TBD"
                    raw_id = str(competitor.get("id") or athlete.get("id") or "")
                    player_id = f"espn-{raw_id}" if raw_id and not raw_id.startswith("-") else f"espn-tbd-{competition_id}-{index + 1}"
                    players.append({
                        "id": player_id,
                        "name": name,
                        "country": country_code(competitor),
                        "rank": competitor.get("curatedRank", {}).get("current"),
                    })
                if any(player["name"].upper() == "TBD" for player in players):
                    continue

                score, set_scores = score_data(competitors)
                winner_id = next((players[index]["id"] for index, item in enumerate(competitors) if item.get("winner")), None)
                time_value = local_start.strftime("%H:%M") if competition.get("timeValid") else None
                level = "Grand Slam" if event.get("major") else "Tour"
                matches[f"espn-{competition_id}"] = {
                    "id": f"espn-{competition_id}",
                    "date": local_start.date().isoformat(),
                    "time": time_value,
                    "status": status_name(competition),
                    "round": competition.get("round", {}).get("displayName"),
                    "court": competition.get("venue", {}).get("court") or None,
                    "bestOf": competition.get("format", {}).get("regulation", {}).get("periods") or 3,
                    "tournament": {
                        "id": f"espn-{event.get('id')}-{tour.lower()}",
                        "name": f"{event_name} · {draw_name}",
                        "tour": tour,
                        "level": level,
                        "surface": None,
                        "city": city.strip() or None,
                        "country": country.strip() or None,
                    },
                    "players": players,
                    "winnerId": winner_id,
                    "score": score,
                    "setScores": set_scores,
                    "stats": None,
                    "sourceUrl": source_link(event),
                }
    return matches


def main():
    now = datetime.now(TIMEZONE)
    start_date = now.date() - timedelta(days=1)
    end_date = now.date() + timedelta(days=7)
    dates = [(start_date + timedelta(days=offset)).strftime("%Y%m%d") for offset in range(9)]
    requests = [
        (tour.upper(), SCOREBOARD.format(tour=tour, date=date))
        for date in dates for tour in ("atp", "wta")
    ]

    collected = {}
    with ThreadPoolExecutor(max_workers=3) as executor:
        for requested_tour, payload in executor.map(get_json, requests):
            collected.update(normalize(payload, start_date, end_date, requested_tour))

    matches = sorted(collected.values(), key=lambda item: (item["date"], item["time"] or "99:99", item["id"]))[:300]
    translated, total_players = enrich_chinese_names(matches)
    output = {"source": "ESPN Tennis scoreboard", "updatedAt": now.isoformat(), "matches": matches}
    output_path = Path(".sync/feed.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, ensure_ascii=False), encoding="utf-8")
    print(f"Prepared {len(matches)} current matches from ESPN ({start_date}..{end_date}); Chinese names {translated}/{total_players}")


if __name__ == "__main__":
    main()

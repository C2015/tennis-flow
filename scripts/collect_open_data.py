"""Collect current ATP/WTA singles schedules and results from ESPN scoreboards."""

from __future__ import annotations

import json
import re
import unicodedata
import urllib.request
from time import sleep
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
from urllib.parse import urlencode

TIMEZONE = ZoneInfo("Asia/Shanghai")
SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/tennis/{tour}/scoreboard?dates={date}"
US_OPEN = "https://www.usopen.org"
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

GRAND_SLAM_WORDS = ("australian open", "roland garros", "french open", "wimbledon", "us open")
PREMIER_WORDS = {
    "ATP": (
        "indian wells", "bnp paribas open", "miami open", "monte-carlo", "monte carlo",
        "madrid open", "mutua madrid", "italian open", "internazionali bnl", "canadian open",
        "national bank open", "rogers cup", "cincinnati open", "western & southern",
        "shanghai masters", "paris masters", "rolex paris", "atp finals", "olympic",
    ),
    "WTA": (
        "qatar open", "doha", "dubai", "indian wells", "bnp paribas open", "miami open",
        "madrid open", "mutua madrid", "italian open", "internazionali bnl", "canadian open",
        "national bank open", "rogers cup", "cincinnati open", "western & southern",
        "china open", "beijing", "wuhan open", "wta finals", "olympic",
    ),
}
ATP_500_WORDS = (
    "rotterdam", "abn amro", "rio open", "qatar open", "doha", "dubai", "mexican open",
    "acapulco", "dallas open", "barcelona open", "munich", "bmw open", "hamburg",
    "halle", "terra wortmann", "queen's", "queens", "washington", "mubadala citi",
    "china open", "beijing", "japan open", "tokyo", "basel", "swiss indoors", "vienna",
    "erste bank",
)
WTA_500_WORDS = (
    "adelaide", "abu dhabi", "berlin", "brisbane", "charleston", "stuttgart", "strasbourg",
    "eastbourne", "queen's", "queens", "washington", "monterrey", "seoul", "korea open",
    "pan pacific", "tokyo", "ningbo", "guadalajara", "merida", "bad homburg", "san diego",
    "linz", "zhengzhou",
)


def tournament_level(event_name, tour, is_major=False):
    """Classify polling priority conservatively; unknown events stay on the slow tier."""
    name = event_name.casefold()
    if is_major or any(word in name for word in GRAND_SLAM_WORDS):
        return "Grand Slam"
    if any(word in name for word in PREMIER_WORDS[tour]):
        if "finals" in name:
            return f"{tour} Finals"
        if "olympic" in name:
            return "Olympics"
        return f"{tour} 1000"
    medium_words = ATP_500_WORDS if tour == "ATP" else WTA_500_WORDS
    if any(word in name for word in medium_words):
        return f"{tour} 500"
    return "Tour"


def get_json(item):
    requested_tour, url = item
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=30) as response:
        return requested_tour, json.load(response)


def fetch_json(url):
    last_error = None
    for attempt in range(2):
        try:
            request = urllib.request.Request(url, headers={**HEADERS, "Accept": "application/json"})
            with urllib.request.urlopen(request, timeout=25) as response:
                return json.load(response)
        except Exception as error:
            last_error = error
            if attempt == 0:
                sleep(0.5)
    raise last_error


def try_fetch_json(url):
    try:
        return fetch_json(url)
    except Exception as error:
        print(f"Optional data source unavailable ({url}): {error}")
        return {}


def country_code(competitor):
    href = competitor.get("athlete", {}).get("flag", {}).get("href", "")
    match = re.search(r"/([a-z]{3})\.png(?:\?|$)", href, re.IGNORECASE)
    return match.group(1).upper() if match else None


def status_name(competition):
    status = competition.get("status", {}).get("type", {})
    description = status.get("description", "").lower()
    if "cancel" in description or "abandon" in description:
        return "cancelled"
    if "postpon" in description or "suspend" in description:
        return "postponed"
    if status.get("state") == "post" or status.get("completed"):
        return "finished"
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


def draw_link(event):
    """Return the draw/bracket page exposed by the scoreboard event, when present."""
    for link in event.get("links", []):
        relations = link.get("rel", [])
        if "bracket" in relations or "draw" in relations:
            return link.get("href")
    return None


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


def normalized_name(value):
    decomposed = unicodedata.normalize("NFKD", value or "")
    ascii_name = "".join(character for character in decomposed if not unicodedata.combining(character))
    return " ".join(sorted(re.sub(r"[^a-z0-9]+", " ", ascii_name.casefold()).split()))


def player_pair_key(names):
    return "|".join(sorted(normalized_name(name) for name in names if name))


def us_open_player_name(team):
    return " ".join(filter(None, (team.get("firstNameA"), team.get("lastNameA")))).strip()


def us_open_stats(match, requested_names, phase="live"):
    base = match.get("base_stats", {}).get("match", {})
    if not base.get("team_1") or not base.get("team_2"):
        return None
    official_names = [us_open_player_name(match.get("team1", {})), us_open_player_name(match.get("team2", {}))]
    official = [normalized_name(name) for name in official_names]
    try:
        order = [official.index(normalized_name(name)) for name in requested_names]
    except ValueError:
        return None
    if len(set(order)) != 2:
        return None

    teams = [base[f"team_{index + 1}"] for index in order]
    serve_match = match.get("serve_stats", {}).get("match", {})
    serve = [serve_match.get(f"team_{index + 1}", {}) for index in order]

    def pair(key):
        return [team.get(key) for team in teams]

    def ratio(team, won, total):
        return f"{team[won]}/{team[total]}" if team.get(won) is not None and team.get(total) is not None else None

    def total_points(team):
        values = [team.get("t_f_srv_w"), team.get("t_s_srv_w"), team.get("t_p_w_opp_srv")]
        return sum(values) if all(isinstance(value, (int, float)) for value in values) else None

    def fastest_serve(team):
        value = team.get("t_f_spd", [None])[0] if isinstance(team.get("t_f_spd"), list) else None
        match_value = re.search(r"\d+", str(value or ""))
        return f"{match_value.group(0)} km/h" if match_value else None

    match_id = str(match.get("match_id") or "")
    return {
        "source": "US Open 官方数据",
        "sourceUrl": f"{US_OPEN}/en_US/scores/stats/{match_id}.html",
        "phase": phase,
        "aces": pair("t_ace"),
        "doubleFaults": pair("df"),
        "firstServe": pair("f_srv_pct"),
        "firstServePointsWon": pair("w_pct_f_srv"),
        "secondServePointsWon": pair("w_pct_s_srv"),
        "breakPoints": [ratio(team, "t_bp_w", "t_bp") for team in teams],
        "netPoints": [ratio(team, "t_np_w", "t_na") for team in teams],
        "winners": pair("t_w"),
        "unforcedErrors": pair("t_ue"),
        "totalPointsWon": [total_points(team) for team in teams],
        "fastestServe": [fastest_serve(team) for team in serve],
    }


def complete_us_open_stats(stats):
    if not stats or stats.get("phase") != "final":
        return False
    totals = stats.get("totalPointsWon")
    first_serve = stats.get("firstServe")
    return (
        isinstance(totals, list) and len(totals) == 2
        and all(isinstance(value, (int, float)) and value > 0 for value in totals)
        and sum(totals) >= 24
        and isinstance(first_serve, list) and len(first_serve) == 2
        and all(isinstance(value, (int, float)) and 0 < value <= 100 for value in first_serve)
    )


def enrich_us_open_stats(matches, start_date, end_date):
    """Attach official US Open statistics only when the player pairing is an exact match."""
    targets = [
        match for match in matches
        if "us open" in match["tournament"]["name"].casefold()
        and match["status"] == "finished"
    ]
    if not targets:
        return 0
    year = start_date.year
    target_dates = {datetime.fromisoformat(match["date"]).date() for match in targets}
    official_dates = target_dates | {date - timedelta(days=1) for date in target_dates}
    urls = [f"{US_OPEN}/en_US/scores/feeds/{year}/matches/live/scores.json"]
    # US Open feed day 1 is the Sunday before main-draw week. Deriving the
    # file number avoids the eventDays index, which is slow from GitHub runners.
    september_first = datetime(year, 9, 1).date()
    labor_day = september_first + timedelta(days=(7 - september_first.weekday()) % 7)
    main_draw_start = labor_day - timedelta(days=8)
    fan_week_start = main_draw_start - timedelta(days=7)
    for event_date in sorted(official_dates):
        tournament_day = (event_date - fan_week_start).days + 1
        if 1 <= tournament_day <= 22:
            urls.append(f"{US_OPEN}/en_US/scores/feeds/{year}/completed_matches/days/day_{tournament_day}.json")

    candidates = {}
    with ThreadPoolExecutor(max_workers=4) as executor:
        for url, payload in zip(urls, executor.map(try_fetch_json, urls)):
            for match in payload.get("matches", []):
                names = [us_open_player_name(match.get("team1", {})), us_open_player_name(match.get("team2", {}))]
                key = player_pair_key(names)
                if key:
                    candidates[key] = match

    details = []
    target_matches = []
    for target in targets:
        names = [player["name"] for player in target["players"]]
        official_match = candidates.get(player_pair_key(names))
        if not official_match:
            continue
        match_id = official_match.get("match_id")
        if match_id:
            details.append(f"{US_OPEN}/en_US/scores/feeds/{year}/matches/complete/{match_id}.json")
            target_matches.append(target)

    if details:
        with ThreadPoolExecutor(max_workers=5) as executor:
            for target, payload in zip(target_matches, executor.map(try_fetch_json, details)):
                official_match = (payload.get("matches") or [None])[0]
                if official_match:
                    stats = us_open_stats(official_match, [player["name"] for player in target["players"]], "final")
                    if complete_us_open_stats(stats):
                        target["stats"] = stats
    return sum(bool(match.get("stats")) for match in targets)


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
                level = tournament_level(event_name, tour, bool(event.get("major")))
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
                        "drawUrl": draw_link(event),
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
    stats_count = enrich_us_open_stats(matches, start_date, end_date)
    translated, total_players = enrich_chinese_names(matches)
    output = {"source": "ESPN Tennis + US Open 官方统计", "updatedAt": now.isoformat(), "matches": matches}
    output_path = Path(".sync/feed.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, ensure_ascii=False), encoding="utf-8")
    print(f"Prepared {len(matches)} current matches from ESPN ({start_date}..{end_date}); official stats {stats_count}; Chinese names {translated}/{total_players}")


if __name__ == "__main__":
    main()

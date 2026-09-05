"""Normalize the latest Open Tennis Data v3 preview for Tennis Flow."""

from __future__ import annotations

import json
import re
import tempfile
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import duckdb

REPO = "ryantjx/tennis-match-data"
RELEASES_API = f"https://api.github.com/repos/{REPO}/releases?per_page=20"
HEADERS = {"Accept": "application/vnd.github+json", "User-Agent": "TennisFlow/0.1"}


def get_json(url: str):
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def download(url: str, destination: Path):
    request = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(request, timeout=60) as response:
        destination.write_bytes(response.read())


def first(value):
    if isinstance(value, (list, tuple)):
        return str(value[0]) if value else None
    return str(value) if value is not None else None


def parse_sets(score: str | None):
    if not score:
        return []
    result = []
    for token in score.split():
        match = re.match(r"^(\d+)-(\d+)", token)
        if match:
            result.append({"p1": int(match.group(1)), "p2": int(match.group(2))})
    return result


def main():
    releases = get_json(RELEASES_API)
    release = next(
        (item for item in releases if not item["draft"] and item["tag_name"].startswith("data-v3-")),
        None,
    )
    if not release:
        raise RuntimeError("No Open Tennis Data v3 release found")
    assets = {asset["name"]: asset["browser_download_url"] for asset in release["assets"]}
    if "matches.parquet" not in assets or "tournaments.parquet" not in assets:
        raise RuntimeError("Release is missing required Parquet assets")

    now = datetime.now(ZoneInfo("Asia/Shanghai"))
    date_from = (now.date() - timedelta(days=1)).isoformat()
    date_to = (now.date() + timedelta(days=7)).isoformat()

    with tempfile.TemporaryDirectory() as temp:
        matches_path = Path(temp) / "matches.parquet"
        tournaments_path = Path(temp) / "tournaments.parquet"
        download(assets["matches.parquet"], matches_path)
        download(assets["tournaments.parquet"], tournaments_path)
        connection = duckdb.connect()

        def select_rows(start: str, end: str):
            return connection.execute(
            """
            SELECT m.date, m.match_id, m.tournament_id, m.tournament_name,
                   upper(m.tour), m.round, m.player1_id, m.player1_name,
                   m.player2_id, m.player2_name, m.winner_id, m.status,
                   m.score, m.best_of, t.level, t.surface, t.city, t.country
            FROM read_parquet(?) m
            LEFT JOIN read_parquet(?) t USING (tournament_id, tour, year)
            WHERE m.date BETWEEN CAST(? AS DATE) AND CAST(? AS DATE)
              AND upper(m.tour) IN ('ATP', 'WTA')
              AND list_count(m.player1_name) = 1
              AND list_count(m.player2_name) = 1
            ORDER BY m.date, m.tournament_name, m.round
            LIMIT 300
            """,
            [str(matches_path), str(tournaments_path), start, end],
            ).fetchall()

        rows = select_rows(date_from, date_to)
        if not rows:
            latest_date = connection.execute(
                """
                SELECT max(date)
                FROM read_parquet(?)
                WHERE upper(tour) IN ('ATP', 'WTA')
                  AND list_count(player1_name) = 1
                  AND list_count(player2_name) = 1
                """,
                [str(matches_path)],
            ).fetchone()[0]
            if latest_date:
                date_to = latest_date.isoformat()
                date_from = (latest_date - timedelta(days=7)).isoformat()
                rows = select_rows(date_from, date_to)
        connection.close()

    normalized = []
    for row in rows:
        (date, match_id, tournament_id, tournament_name, tour, round_name,
         p1_id, p1_name, p2_id, p2_name, winner_id, status, score, best_of,
         level, surface, city, country) = row
        first_id, second_id = first(p1_id), first(p2_id)
        first_name, second_name = first(p1_name), first(p2_name)
        if not all((date, match_id, tournament_id, first_id, second_id, first_name, second_name)):
            continue
        mapped_status = (
            "scheduled" if status == "fixture"
            else "cancelled" if status in ("cancelled", "abandoned")
            else "finished"
        )
        normalized.append({
            "id": match_id,
            "date": date.isoformat(),
            "time": None,
            "status": mapped_status,
            "round": round_name,
            "court": None,
            "bestOf": best_of or 3,
            "tournament": {
                "id": tournament_id,
                "name": tournament_name,
                "tour": tour,
                "level": level or "Tour",
                "surface": surface,
                "city": city,
                "country": country,
            },
            "players": [
                {"id": first_id, "name": first_name, "country": None, "rank": None},
                {"id": second_id, "name": second_name, "country": None, "rank": None},
            ],
            "winnerId": first(winner_id),
            "score": score,
            "setScores": parse_sets(score),
            "stats": None,
            "sourceUrl": release["html_url"],
        })

    output = {
        "source": "Open Tennis Data v3 preview",
        "updatedAt": release["published_at"],
        "matches": normalized,
    }
    output_path = Path(".sync/feed.json")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, ensure_ascii=False), encoding="utf-8")
    print(f"Prepared {len(normalized)} matches from {release['tag_name']} ({date_from}..{date_to})")


if __name__ == "__main__":
    main()

"""The agent's own tool: the current time.

The model asks for it; this process runs it and hands back the result. (Web
search is different: Higgs Realtime runs it on Boson's servers, so there is no
code for it here. This file is identical in pipecat/ and livekit/.)
"""

import os
import re
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def local_timezone() -> str:
    """This computer's time zone as an IANA name, such as America/Toronto.

    The agent runs where the caller is (your laptop, in this tutorial), so the
    time zone is a fair guess at where the caller is too.
    """
    if os.environ.get("TZ"):
        return os.environ["TZ"].lstrip(":")
    target = os.path.realpath("/etc/localtime")  # a link into the zoneinfo database
    if "zoneinfo/" in target:
        return target.split("zoneinfo/", 1)[1]
    return datetime.now().astimezone().tzname() or "UTC"


def current_time(timezone: str | None = None) -> dict:
    try:
        zone = ZoneInfo(timezone or local_timezone())
    except (ZoneInfoNotFoundError, ValueError):
        return {"error": f"Unknown time zone {timezone!r}; use an IANA name such as Europe/Paris."}
    now = datetime.now(zone).astimezone(zone)
    return {"time": now.strftime("%A %d %B %Y, %H:%M"), "timezone": str(now.tzinfo)}


def source_urls(search_output: str) -> list[str]:
    """The web pages a server-side web search read, for showing as sources.

    The search result text is written for the model and its format may change,
    so take nothing from it but the links.
    """
    return list(dict.fromkeys(re.findall(r"https?://[^\s)\]>\"']+", search_output or "")))

"""Server-side tools, such as web search, for the Boson LiveKit plugin.

Higgs Realtime runs some tools itself: declare {"type": "web_search"} and it
searches the web and speaks the answer. The plugin does not know these yet, in
two ways this module covers:

- It only sends function tools to the server, so it would drop web_search.
  RealtimeModel(server_tools=[...]) adds them to the session.
- A server-run search arrives as a function_call with "executor": "server". The
  plugin would hand it to the agent to run, and the agent would answer it with
  an error. The server runs it and continues on its own, so it is skipped here.
"""

import logging
from typing import Any

from livekit.agents import llm
from livekit.plugins import boson
from livekit.plugins.boson.realtime import realtime_model as boson_realtime

import tools

logger = logging.getLogger("willow")


class RealtimeSession(boson_realtime.RealtimeSession):
    def __init__(self, realtime_model: "RealtimeModel") -> None:
        super().__init__(realtime_model)
        self.on("openai_server_event_received", self._log_server_tool_items)

    def _log_server_tool_items(self, event: dict[str, Any]) -> None:
        # A server-side search shows up as conversation items: the call (with
        # executor "server") and, when the search is done, its result. Log the
        # pages it read; a client could show them as sources.
        item = event.get("item") or {}
        if event.get("type") != "conversation.item.added":
            return
        if item.get("type") == "function_call" and item.get("executor") == "server":
            logger.info("Searching the web (%s)", item.get("name"))
        elif item.get("type") == "function_call_output" and (urls := tools.source_urls(item.get("output", ""))):
            logger.info("Web search sources: %s", ", ".join(urls))

    def _tools_to_boson_warning_on_drop(self, function_tools: list[llm.Tool]) -> list[dict[str, Any]]:
        server = [dict(tool) for tool in self._boson_model.server_tools]
        return super()._tools_to_boson_warning_on_drop(function_tools) + server

    def _handle_response_output_item_done(self, event) -> None:
        if event.item.type == "function_call" and getattr(event.item, "executor", None) == "server":
            return  # the server runs it and speaks the answer itself
        super()._handle_response_output_item_done(event)


class RealtimeModel(boson.realtime.RealtimeModel):
    def __init__(self, *, server_tools: list[dict[str, Any]] | None = None, **kwargs: Any) -> None:
        self.server_tools = list(server_tools or [])
        super().__init__(**kwargs)

    def session(self, *, turn_detection_disabled: bool = False) -> RealtimeSession:
        session = RealtimeSession(self)
        self._sessions.add(session)
        return session

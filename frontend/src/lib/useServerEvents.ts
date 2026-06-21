import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

type SSEEvent = { type: string; id?: number };

export function useServerEvents(enabled: boolean) {
  const qc = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;

    function connect() {
      if (!alive) return;
      es = new EventSource("/api/events");

      es.onmessage = (e: MessageEvent) => {
        try {
          const event = JSON.parse(e.data) as SSEEvent;
          switch (event.type) {
            case "jobs":
              qc.invalidateQueries({ queryKey: ["jobs"] });
              break;
            case "nodes":
              qc.invalidateQueries({ queryKey: ["nodes"] });
              break;
            case "runs":
              qc.invalidateQueries({ queryKey: ["runs"] });
              qc.invalidateQueries({ queryKey: ["runs", "unread"] });
              break;
            case "run":
              if (event.id != null) {
                qc.invalidateQueries({ queryKey: ["run", event.id] });
              }
              // run state change also affects the list and unread badge
              qc.invalidateQueries({ queryKey: ["runs"] });
              qc.invalidateQueries({ queryKey: ["runs", "unread"] });
              break;
          }
        } catch {
          // ignore malformed events
        }
      };

      es.onerror = () => {
        es?.close();
        es = null;
        if (alive) {
          timer = setTimeout(connect, 5000);
        }
      };
    }

    connect();

    return () => {
      alive = false;
      if (timer != null) clearTimeout(timer);
      es?.close();
    };
  }, [qc, enabled]);
}

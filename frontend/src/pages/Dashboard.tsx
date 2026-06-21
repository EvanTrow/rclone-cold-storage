import {
  Box,
  Card,
  CardContent,
  CardHeader,
  Chip,
  Typography,
} from "@mui/material";
import { useQuery } from "@tanstack/react-query";
import { nodesApi, runsApi, type Node, type Run } from "../lib/api";

function statusColor(
  status: Node["status"],
): "success" | "warning" | "error" | "default" {
  if (status === "online") return "success";
  if (status === "waking") return "warning";
  if (status === "offline") return "error";
  return "default";
}

function NodeCard({ node }: { node: Node }) {
  const { data: runs } = useQuery({
    queryKey: ["runs"],
    queryFn: () => runsApi.list(),
    staleTime: 60_000,
  });

  const lastRun: Run | undefined = runs
    ?.filter((r) => r.job_id !== undefined)
    .sort((a, b) =>
      (b.started_at ?? "").localeCompare(a.started_at ?? ""),
    )[0];

  return (
    <Card>
      <CardHeader
        title={
          <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <Typography variant="subtitle1" fontWeight={600}>{node.name}</Typography>
            <Chip
              label={node.status}
              color={statusColor(node.status)}
              size="small"
              variant="outlined"
            />
          </Box>
        }
        disableTypography
        sx={{ pb: 0 }}
      />
      <CardContent>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            IP: {node.ip}
          </Typography>
          {node.last_seen && (
            <Typography variant="body2" color="text.secondary">
              Last seen: {new Date(node.last_seen).toLocaleString()}
            </Typography>
          )}
          {node.last_cache_refresh && (
            <Typography variant="body2" color="text.secondary">
              Cache: {new Date(node.last_cache_refresh).toLocaleString()}
            </Typography>
          )}
          {lastRun && (
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 0.5 }}>
              <Typography variant="body2" color="text.secondary">
                Last run:
              </Typography>
              <Chip
                label={lastRun.status}
                size="small"
                variant="outlined"
                color={
                  lastRun.status === "success"
                    ? "success"
                    : lastRun.status === "failed"
                      ? "error"
                      : "default"
                }
              />
              <Typography variant="caption" color="text.secondary">
                {lastRun.started_at
                  ? new Date(lastRun.started_at).toLocaleString()
                  : ""}
              </Typography>
            </Box>
          )}
        </Box>
      </CardContent>
    </Card>
  );
}

export function Dashboard() {
  const { data: nodes, isLoading } = useQuery({
    queryKey: ["nodes"],
    queryFn: nodesApi.list,
    refetchInterval: 30_000,
  });

  const { data: activeRuns } = useQuery({
    queryKey: ["runs", "running"],
    queryFn: () => runsApi.list({ status: "running" }),
    refetchInterval: 5_000,
  });

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Typography variant="h5" fontWeight={700}>
          Dashboard
        </Typography>
        {activeRuns && activeRuns.length > 0 && (
          <Chip
            label={`${activeRuns.length} job${activeRuns.length > 1 ? "s" : ""} running`}
            color="warning"
            variant="outlined"
            size="small"
          />
        )}
      </Box>

      {isLoading && (
        <Typography color="text.secondary">Loading nodes…</Typography>
      )}
      {!isLoading && nodes?.length === 0 && (
        <Typography color="text.secondary">
          No nodes configured yet. Go to <strong>Nodes</strong> to add one.
        </Typography>
      )}

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: {
            xs: "1fr",
            sm: "repeat(2, 1fr)",
            lg: "repeat(3, 1fr)",
          },
          gap: 2,
        }}
      >
        {nodes?.map((node) => <NodeCard key={node.id} node={node} />)}
      </Box>
    </Box>
  );
}

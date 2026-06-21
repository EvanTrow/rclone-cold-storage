import RefreshIcon from "@mui/icons-material/Refresh";
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  Paper,
  Tooltip,
  Typography,
} from "@mui/material";
import { SimpleTreeView } from "@mui/x-tree-view/SimpleTreeView";
import { TreeItem } from "@mui/x-tree-view/TreeItem";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { type CacheEntry, nodesApi } from "../lib/api";

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  size_bytes: number | null;
  children: TreeNode[];
}

function buildTree(entries: CacheEntry[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  for (const e of entries) {
    map.set(e.path, { name: e.name, path: e.path, type: e.type, size_bytes: e.size_bytes, children: [] });
  }
  const roots: TreeNode[] = [];
  for (const e of entries) {
    const node = map.get(e.path)!;
    const lastSlash = e.path.lastIndexOf("/");
    const parentPath = lastSlash > 0 ? e.path.slice(0, lastSlash) : "";
    if (parentPath && map.has(parentPath)) {
      map.get(parentPath)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) sort(n.children);
  };
  sort(roots);
  return roots;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function collectDescendants(node: TreeNode): string[] {
  const ids: string[] = [];
  const walk = (n: TreeNode) => {
    for (const child of n.children) {
      ids.push(child.path);
      if (child.type === "dir") walk(child);
    }
  };
  walk(node);
  return ids;
}

function buildNodeMap(nodes: TreeNode[]): Map<string, TreeNode> {
  const map = new Map<string, TreeNode>();
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      map.set(n.path, n);
      if (n.type === "dir") walk(n.children);
    }
  };
  walk(nodes);
  return map;
}

function TreeItemLabel({ node }: { node: TreeNode }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, py: 0.25 }}>
      <span style={{ fontSize: 14 }}>{node.type === "dir" ? "📁" : "📄"}</span>
      <Typography variant="body2" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>
        {node.name}
      </Typography>
      {node.type === "file" && node.size_bytes !== null && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ flexShrink: 0, ml: 1 }}
        >
          {fmtBytes(node.size_bytes)}
        </Typography>
      )}
    </Box>
  );
}

function renderTree(nodes: TreeNode[], dirsOnly: boolean): React.ReactNode {
  return nodes
    .filter((n) => !dirsOnly || n.type === "dir")
    .map((n) => (
      <TreeItem key={n.path} itemId={n.path} label={<TreeItemLabel node={n} />}>
        {n.type === "dir" ? renderTree(n.children, dirsOnly) : null}
      </TreeItem>
    ));
}

interface FileBrowserProps {
  nodeId: number | undefined;
  selected: string[];
  onChange: (paths: string[]) => void;
  multiSelect?: boolean;
  dirsOnly?: boolean;
}

export function FileBrowser({
  nodeId,
  selected,
  onChange,
  multiSelect = true,
  dirsOnly = false,
}: FileBrowserProps) {
  const qc = useQueryClient();
  const [waiting, setWaiting] = useState(false);

  const { data: entries, isLoading, isFetching } = useQuery({
    queryKey: ["nodeFiles", nodeId],
    queryFn: () => nodesApi.getFiles(nodeId!),
    enabled: nodeId !== undefined,
    staleTime: 60_000,
  });

  const refreshMut = useMutation({
    mutationFn: () => nodesApi.refreshFiles(nodeId!),
    onSuccess: () => {
      setWaiting(true);
      setTimeout(() => {
        setWaiting(false);
        qc.invalidateQueries({ queryKey: ["nodeFiles", nodeId] });
      }, 5000);
    },
  });

  const tree = useMemo(() => (entries ? buildTree(entries) : []), [entries]);
  const nodeMap = useMemo(() => buildNodeMap(tree), [tree]);

  function handleMultiSelectionChange(_: React.SyntheticEvent, newIds: string[]) {
    // selected may contain trailing slashes for dirs; strip for comparison against tree IDs
    const prevRaw = selected.map((p) => p.replace(/\/$/, ""));
    const prevSet = new Set(prevRaw);
    const nextSet = new Set(newIds);
    const added = newIds.filter((id) => !prevSet.has(id));
    const removed = prevRaw.filter((id) => !nextSet.has(id));

    const result = new Set(newIds);

    for (const id of added) {
      const n = nodeMap.get(id);
      if (n?.type === "dir") {
        collectDescendants(n).forEach((d) => result.add(d));
      }
    }
    for (const id of removed) {
      const n = nodeMap.get(id);
      if (n?.type === "dir") {
        collectDescendants(n).forEach((d) => result.delete(d));
      }
    }

    // Drop paths already covered by a selected parent directory to avoid double copies
    const topLevel = [...result].filter(
      (path) =>
        ![...result].some((other) => {
          const n = nodeMap.get(other);
          return n?.type === "dir" && path !== other && path.startsWith(other + "/");
        }),
    );

    // Append trailing slash to directories so the backend can distinguish them from files
    onChange(
      topLevel.map((path) => {
        const n = nodeMap.get(path);
        return n?.type === "dir" ? path + "/" : path;
      }),
    );
  }

  function handleSingleSelectionChange(_: React.SyntheticEvent, id: string | null) {
    onChange(id ? [id] : []);
  }

  const isBusy = refreshMut.isPending || isFetching || waiting;

  if (nodeId === undefined) {
    return (
      <Paper
        variant="outlined"
        sx={{ px: 2, py: 3, textAlign: "center" }}
      >
        <Typography variant="body2" color="text.secondary">
          Select a node to browse files.
        </Typography>
      </Paper>
    );
  }

  const treeContent = renderTree(tree, dirsOnly);

  const header = (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        px: 1.5,
        py: 0.75,
        borderBottom: 1,
        borderColor: "divider",
        bgcolor: "action.hover",
      }}
    >
      <Typography variant="caption" color="text.secondary">
        {isLoading
          ? "Loading…"
          : waiting
            ? "Refreshing cache…"
            : entries
              ? `${entries.length} entries cached`
              : "No cache loaded"}
      </Typography>
      <Tooltip title="Refresh file cache">
        <span>
          <IconButton
            size="small"
            onClick={() => refreshMut.mutate()}
            disabled={isBusy}
          >
            {isBusy ? (
              <CircularProgress size={16} />
            ) : (
              <RefreshIcon sx={{ fontSize: 18 }} />
            )}
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  );

  const emptyState = (
    <Box sx={{ textAlign: "center", py: 4 }}>
      <Typography variant="body2" color="text.secondary" gutterBottom>
        No files cached yet.
      </Typography>
      <Button
        size="small"
        variant="outlined"
        onClick={() => refreshMut.mutate()}
        disabled={refreshMut.isPending}
      >
        Refresh cache now
      </Button>
    </Box>
  );

  return (
    <Paper variant="outlined" sx={{ overflow: "hidden" }}>
      {header}
      <Box sx={{ maxHeight: 260, overflowY: "auto", py: 0.5 }}>
        {isLoading ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
            <CircularProgress size={24} />
          </Box>
        ) : tree.length === 0 ? (
          emptyState
        ) : multiSelect ? (
          <SimpleTreeView
            checkboxSelection
            multiSelect
            selectedItems={selected.map((p) => p.replace(/\/$/, ""))}
            onSelectedItemsChange={handleMultiSelectionChange}
            sx={{ "& .MuiTreeItem-content": { py: 0.25 } }}
          >
            {treeContent}
          </SimpleTreeView>
        ) : (
          <SimpleTreeView
            selectedItems={(selected[0] ?? "").replace(/\/$/, "") || null}
            onSelectedItemsChange={handleSingleSelectionChange}
            sx={{ "& .MuiTreeItem-content": { py: 0.25 } }}
          >
            {treeContent}
          </SimpleTreeView>
        )}
      </Box>
    </Paper>
  );
}

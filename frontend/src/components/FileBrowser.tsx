import RefreshIcon from '@mui/icons-material/Refresh';
import { Box, Button, Checkbox, CircularProgress, IconButton, Paper, Tooltip, Typography } from '@mui/material';
import { SimpleTreeView } from '@mui/x-tree-view/SimpleTreeView';
import { TreeItem } from '@mui/x-tree-view/TreeItem';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { type CacheEntry, nodesApi } from '../lib/api';
import { Folder, Home, InsertDriveFile } from '@mui/icons-material';

// ─── Tree data model ──────────────────────────────────────────────────────────

interface TreeNode {
	name: string;
	path: string;
	type: 'file' | 'dir';
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
		const lastSlash = e.path.lastIndexOf('/');
		const parentPath = lastSlash > 0 ? e.path.slice(0, lastSlash) : '';
		if (parentPath && map.has(parentPath)) {
			map.get(parentPath)!.children.push(node);
		} else {
			roots.push(node);
		}
	}
	const sort = (nodes: TreeNode[]) => {
		nodes.sort((a, b) => {
			if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		for (const n of nodes) sort(n.children);
	};
	sort(roots);
	return roots;
}

function buildNodeMap(nodes: TreeNode[]): Map<string, TreeNode> {
	const map = new Map<string, TreeNode>();
	const walk = (list: TreeNode[]) => {
		for (const n of list) {
			map.set(n.path, n);
			if (n.type === 'dir') walk(n.children);
		}
	};
	walk(nodes);
	return map;
}

function collectDescendants(node: TreeNode): string[] {
	const ids: string[] = [];
	const walk = (n: TreeNode) => {
		for (const child of n.children) {
			ids.push(child.path);
			if (child.type === 'dir') walk(child);
		}
	};
	walk(node);
	return ids;
}

// ─── Selection helpers ────────────────────────────────────────────────────────

function isDescendantOf(id: string, ancestor: string): boolean {
	const prefix = ancestor === '/' ? '/' : ancestor + '/';
	return id !== ancestor && id.startsWith(prefix);
}

/**
 * Add all (visible) children of `node` to `result`, except for paths in
 * `missing` or branches containing a missing descendant (which are recursed
 * into to preserve their siblings).
 */
function explodeExcept(node: TreeNode, missing: Set<string>, result: Set<string>, nodeMap: Map<string, TreeNode>, itemFilter: (n: TreeNode) => boolean): void {
	for (const child of node.children) {
		if (!itemFilter(child)) continue;
		if (missing.has(child.path)) {
			// This is the removed item — skip it
		} else if ([...missing].some((m) => isDescendantOf(m, child.path))) {
			// A descendant was removed — preserve its siblings by recursing
			explodeExcept(child, missing, result, nodeMap, itemFilter);
		} else {
			result.add(child.path);
		}
	}
}

/**
 * If all visible children of a folder are individually in `canonicalIds`,
 * replace them with just the parent. Repeats until stable.
 */
function promote(canonicalIds: Set<string>, nodeMap: Map<string, TreeNode>, itemFilter: (n: TreeNode) => boolean): void {
	let changed = true;
	while (changed) {
		changed = false;
		for (const [path, node] of nodeMap) {
			if (node.type !== 'dir' || canonicalIds.has(path)) continue;
			const visible = node.children.filter(itemFilter);
			if (visible.length === 0) continue;
			if (visible.every((c) => canonicalIds.has(c.path))) {
				canonicalIds.add(path);
				visible.forEach((c) => canonicalIds.delete(c.path));
				changed = true;
				break;
			}
		}
	}
}

// ─── Rendering helpers ────────────────────────────────────────────────────────

function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
	return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** Tree item for single-select destination browser (no checkbox). */
function renderTree(nodes: TreeNode[], dirsOnly: boolean): React.ReactNode {
	return nodes
		.filter((n) => !dirsOnly || n.type === 'dir')
		.map((n) => (
			<TreeItem
				key={n.path}
				itemId={n.path}
				label={
					<Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, py: 0.25 }}>
						<span style={{ fontSize: 14 }}>{n.type === 'dir' ? '📁' : '📄'}</span>
						<Typography variant='body2' noWrap sx={{ flexGrow: 1, minWidth: 0 }}>
							{n.name}
						</Typography>
						{n.type === 'file' && n.size_bytes !== null && (
							<Typography variant='caption' color='text.secondary' sx={{ flexShrink: 0, ml: 1 }}>
								{fmtBytes(n.size_bytes)}
							</Typography>
						)}
					</Box>
				}
			>
				{n.type === 'dir' ? renderTree(n.children, dirsOnly) : null}
			</TreeItem>
		));
}

/** Tree item for multi-select source browser (custom checkbox with indeterminate). */
function MultiSelectItem({
	node,
	dirsOnly,
	checkedSet,
	indeterminateSet,
	onToggle,
}: {
	node: TreeNode;
	dirsOnly: boolean;
	checkedSet: Set<string>;
	indeterminateSet: Set<string>;
	onToggle: (id: string, checked: boolean) => void;
}) {
	if (dirsOnly && node.type === 'file') return null;
	return (
		<TreeItem
			itemId={node.path}
			label={
				<Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, py: 0.25 }}>
					<Checkbox
						size='small'
						checked={checkedSet.has(node.path)}
						indeterminate={indeterminateSet.has(node.path)}
						onChange={(e) => onToggle(node.path, e.target.checked)}
						onClick={(e) => e.stopPropagation()}
						sx={{ p: 0.25, ml: -0.5 }}
						tabIndex={-1}
					/>
					{node.type === 'dir' ? <Folder sx={{ fontSize: 18, color: 'primary.main' }} /> : <InsertDriveFile sx={{ fontSize: 18, color: 'text.secondary' }} />}
					<Typography variant='body2' noWrap sx={{ flexGrow: 1, minWidth: 0 }}>
						{node.name}
					</Typography>
					{node.type === 'file' && node.size_bytes !== null && (
						<Typography variant='caption' color='text.secondary' sx={{ flexShrink: 0, ml: 1 }}>
							{fmtBytes(node.size_bytes)}
						</Typography>
					)}
				</Box>
			}
		>
			{node.type === 'dir'
				? node.children.map((child) => <MultiSelectItem key={child.path} node={child} dirsOnly={dirsOnly} checkedSet={checkedSet} indeterminateSet={indeterminateSet} onToggle={onToggle} />)
				: null}
		</TreeItem>
	);
}

// ─── Component ────────────────────────────────────────────────────────────────

interface FileBrowserProps {
	nodeId: number | undefined;
	sftpRoot?: string;
	selected: string[];
	onChange: (paths: string[]) => void;
	multiSelect?: boolean;
	dirsOnly?: boolean;
}

export function FileBrowser({ nodeId, sftpRoot = '/', selected, onChange, multiSelect = true, dirsOnly = false }: FileBrowserProps) {
	const qc = useQueryClient();
	const [waiting, setWaiting] = useState(false);

	const {
		data: entries,
		isLoading,
		isFetching,
	} = useQuery({
		queryKey: ['nodeFiles', nodeId],
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
				qc.invalidateQueries({ queryKey: ['nodeFiles', nodeId] });
			}, 5000);
		},
	});

	const rootPath = sftpRoot.replace(/\/$/, '') || '/';
	const toItemId = (path: string): string => path.replace(/\/$/, '') || rootPath;
	const itemFilter = (n: TreeNode) => !dirsOnly || n.type === 'dir';

	const tree = useMemo(() => (entries ? buildTree(entries) : []), [entries]);

	const nodeMap = useMemo(() => {
		const map = buildNodeMap(tree);
		map.set(rootPath, { name: rootPath, path: rootPath, type: 'dir', size_bytes: null, children: tree });
		return map;
	}, [tree, rootPath]);

	/**
	 * Expanded visual selection: every item that should appear checked.
	 * Includes the canonical item itself plus all its visible descendants.
	 */
	const expandedItems = useMemo(() => {
		const result = new Set<string>();
		for (const path of selected) {
			const id = toItemId(path);
			const n = nodeMap.get(id);
			if (!dirsOnly || n?.type !== 'file') result.add(id);
			if (n?.type === 'dir') {
				for (const d of collectDescendants(n)) {
					const dn = nodeMap.get(d);
					if (!dirsOnly || dn?.type === 'dir') result.add(d);
				}
			}
		}
		return result;
		// toItemId is derived from rootPath; listing rootPath is sufficient
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selected, nodeMap, dirsOnly, rootPath]);

	/**
	 * Items that are partially selected: NOT in expandedItems themselves but
	 * have at least one visible descendant that IS in expandedItems.
	 */
	const indeterminateItems = useMemo(() => {
		const result = new Set<string>();
		for (const [id, node] of nodeMap) {
			if (node.type !== 'dir' || expandedItems.has(id)) continue;
			const hasCheckedChild = collectDescendants(node).some((d) => {
				if (dirsOnly && nodeMap.get(d)?.type !== 'dir') return false;
				return expandedItems.has(d);
			});
			if (hasCheckedChild) result.add(id);
		}
		return result;
	}, [expandedItems, nodeMap, dirsOnly]);

	/**
	 * Direct toggle handler used by custom checkboxes.
	 * `checked=true`  → add itemId to canonical, remove any descendants it covers.
	 * `checked=false` → remove itemId, or explode the ancestor that covered it.
	 */
	function handleToggle(itemId: string, checked: boolean) {
		const newCanonical = new Set(selected.map(toItemId));

		if (checked) {
			newCanonical.add(itemId);
			// Remove any descendants that are now covered by this item
			for (const c of [...newCanonical]) {
				if (isDescendantOf(c, itemId)) newCanonical.delete(c);
			}
			// Safety: if an ancestor already covers this item, remove the duplicate
			for (const a of newCanonical) {
				if (a !== itemId && isDescendantOf(itemId, a)) {
					newCanonical.delete(itemId);
					break;
				}
			}
		} else {
			if (newCanonical.has(itemId)) {
				newCanonical.delete(itemId);
			} else {
				// Find the ancestor that covers this item and explode it
				const ancestor = [...newCanonical].find((a) => isDescendantOf(itemId, a));
				if (ancestor) {
					newCanonical.delete(ancestor);
					const ancestorNode = nodeMap.get(ancestor);
					if (ancestorNode) {
						explodeExcept(ancestorNode, new Set([itemId]), newCanonical, nodeMap, itemFilter);
					}
				}
			}
		}

		promote(newCanonical, nodeMap, itemFilter);

		onChange(
			[...newCanonical].map((id) => {
				const n = nodeMap.get(id);
				return n?.type === 'dir' ? id + '/' : id;
			}),
		);
	}

	function handleSingleSelectionChange(_: React.SyntheticEvent, id: string | null) {
		onChange(id ? [id] : []);
	}

	const isBusy = refreshMut.isPending || isFetching || waiting;

	if (nodeId === undefined) {
		return (
			<Paper variant='outlined' sx={{ px: 2, py: 3, textAlign: 'center' }}>
				<Typography variant='body2' color='text.secondary'>
					Select a node to browse files.
				</Typography>
			</Paper>
		);
	}

	const rootChecked = expandedItems.has(rootPath);
	const rootIndeterminate = indeterminateItems.has(rootPath);

	const rootLabel = (
		<Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, py: 0.25 }}>
			{multiSelect && (
				<Checkbox
					size='small'
					checked={rootChecked}
					indeterminate={rootIndeterminate}
					onChange={(e) => handleToggle(rootPath, e.target.checked)}
					onClick={(e) => e.stopPropagation()}
					sx={{ p: 0.25, ml: -0.5 }}
					tabIndex={-1}
				/>
			)}
			<Home sx={{ fontSize: 18 }} />
			<Typography variant='body2' noWrap sx={{ flexGrow: 1, minWidth: 0 }}>
				{rootPath}
			</Typography>
		</Box>
	);

	const emptyState = (
		<Box sx={{ textAlign: 'center', py: 3 }}>
			<Typography variant='body2' color='text.secondary' gutterBottom>
				No files cached yet.
			</Typography>
			<Button size='small' variant='outlined' onClick={() => refreshMut.mutate()} disabled={refreshMut.isPending}>
				Refresh cache now
			</Button>
		</Box>
	);

	const innerContent = isLoading ? (
		<Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
			<CircularProgress size={20} />
		</Box>
	) : tree.length === 0 ? (
		emptyState
	) : multiSelect ? (
		tree.map((n) => <MultiSelectItem key={n.path} node={n} dirsOnly={dirsOnly} checkedSet={expandedItems} indeterminateSet={indeterminateItems} onToggle={handleToggle} />)
	) : (
		renderTree(tree, dirsOnly)
	);

	const header = (
		<Box
			sx={{
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				px: 1.5,
				py: 0.75,
				borderBottom: 1,
				borderColor: 'divider',
				bgcolor: 'action.hover',
			}}
		>
			<Typography variant='caption' color='text.secondary'>
				{isLoading ? 'Loading…' : waiting ? 'Refreshing cache…' : entries ? `${entries.length} entries cached` : 'No cache loaded'}
			</Typography>
			<Tooltip title='Refresh file cache'>
				<span>
					<IconButton size='small' onClick={() => refreshMut.mutate()} disabled={isBusy}>
						{isBusy ? <CircularProgress size={16} /> : <RefreshIcon sx={{ fontSize: 18 }} />}
					</IconButton>
				</span>
			</Tooltip>
		</Box>
	);

	return (
		<Paper variant='outlined' sx={{ overflow: 'hidden' }}>
			{header}
			<Box sx={{ maxHeight: 260, overflowY: 'auto', py: 0.5 }}>
				{multiSelect ? (
					// MUI selection is disabled — checkboxes are fully managed by us.
					<SimpleTreeView disableSelection defaultExpandedItems={[rootPath]} sx={{ '& .MuiTreeItem-content': { py: 0.25 } }}>
						<TreeItem itemId={rootPath} label={rootLabel}>
							{innerContent}
						</TreeItem>
					</SimpleTreeView>
				) : (
					<SimpleTreeView
						selectedItems={selected.length > 0 ? toItemId(selected[0]) : null}
						defaultExpandedItems={[rootPath]}
						onSelectedItemsChange={handleSingleSelectionChange}
						sx={{ '& .MuiTreeItem-content': { py: 0.25 } }}
					>
						<TreeItem itemId={rootPath} label={rootLabel}>
							{innerContent}
						</TreeItem>
					</SimpleTreeView>
				)}
			</Box>
		</Paper>
	);
}

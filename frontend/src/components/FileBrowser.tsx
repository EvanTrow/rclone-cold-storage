import ChevronRight from '@mui/icons-material/ChevronRight';
import ExpandMore from '@mui/icons-material/ExpandMore';
import Folder from '@mui/icons-material/Folder';
import Home from '@mui/icons-material/Home';
import InsertDriveFile from '@mui/icons-material/InsertDriveFile';
import { Box, Checkbox, CircularProgress, Paper, Skeleton, Typography } from '@mui/material';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { nodesApi, type SftpEntry } from '../lib/api';

// All rows share the same pixel height — required for fixed-size virtualizer math.
const ITEM_HEIGHT = 28;
// Visible area of the scroll container in pixels.
const CONTAINER_HEIGHT = 272;

// ─── Pure selection helpers ────────────────────────────────────────────────────

interface MapNode {
	path: string;
	type: 'file' | 'dir';
	children: SftpEntry[];
}

function isDescendantOf(id: string, ancestor: string): boolean {
	const prefix = ancestor === '/' ? '/' : ancestor + '/';
	return id !== ancestor && id.startsWith(prefix);
}

function collectDescendants(node: MapNode, map: Map<string, MapNode>): string[] {
	const ids: string[] = [];
	function walk(n: MapNode) {
		for (const c of n.children) {
			ids.push(c.path);
			const cn = map.get(c.path);
			if (cn?.type === 'dir') walk(cn);
		}
	}
	walk(node);
	return ids;
}

function explodeExcept(
	node: MapNode,
	missing: Set<string>,
	result: Set<string>,
	map: Map<string, MapNode>,
	filter: (e: SftpEntry) => boolean,
): void {
	for (const child of node.children) {
		if (!filter(child)) continue;
		if (missing.has(child.path)) continue;
		if ([...missing].some(m => isDescendantOf(m, child.path))) {
			const cn = map.get(child.path);
			if (cn) explodeExcept(cn, missing, result, map, filter);
		} else {
			result.add(child.path);
		}
	}
}

function promote(
	canonical: Set<string>,
	map: Map<string, MapNode>,
	filter: (e: SftpEntry) => boolean,
): void {
	let changed = true;
	while (changed) {
		changed = false;
		for (const [path, node] of map) {
			if (node.type !== 'dir' || canonical.has(path)) continue;
			const visible = node.children.filter(filter);
			if (visible.length > 0 && visible.every(c => canonical.has(c.path))) {
				canonical.add(path);
				visible.forEach(c => canonical.delete(c.path));
				changed = true;
				break;
			}
		}
	}
}

function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
	return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

// ─── Flat list types and builder ──────────────────────────────────────────────

type FlatItem =
	| { kind: 'entry'; entry: SftpEntry; depth: number; isExpanded: boolean }
	| { kind: 'skel'; key: string; depth: number; idx: number }
	| { kind: 'error'; key: string; depth: number; msg: string }
	| { kind: 'empty'; key: string; depth: number };

interface DirState {
	loading: boolean;
	entries: SftpEntry[];
	error: string | null;
}

function buildFlatList(
	dirPath: string,
	dirs: Map<string, DirState>,
	expandedPaths: Set<string>,
	depth: number,
	dirsOnly: boolean,
): FlatItem[] {
	const state = dirs.get(dirPath);
	if (!state || state.loading) {
		return ([0, 1, 2] as const).map(idx => ({
			kind: 'skel' as const,
			key: `${dirPath}/__sk${idx}`,
			depth,
			idx,
		}));
	}
	if (state.error) {
		return [{ kind: 'error', key: `${dirPath}/__err`, depth, msg: state.error }];
	}
	const all = dirsOnly ? state.entries.filter(e => e.type === 'dir') : state.entries;
	if (all.length === 0) {
		return [{ kind: 'empty', key: `${dirPath}/__empty`, depth }];
	}
	const result: FlatItem[] = [];
	for (const entry of all) {
		const isDir = entry.type === 'dir';
		const isExpanded = isDir && expandedPaths.has(entry.path);
		result.push({ kind: 'entry', entry, depth, isExpanded });
		if (isExpanded) {
			result.push(...buildFlatList(entry.path, dirs, expandedPaths, depth + 1, dirsOnly));
		}
	}
	return result;
}

function flatKey(item: FlatItem): string {
	return item.kind === 'entry' ? item.entry.path : item.key;
}

// ─── Memoized entry row ───────────────────────────────────────────────────────

interface EntryRowProps {
	entry: SftpEntry;
	depth: number;
	isExpanded: boolean;
	checked: boolean;
	indeterminate: boolean;
	isSelected: boolean;
	multiSelect: boolean;
	onChevron: (path: string) => void;
	onCheck: (path: string, checked: boolean) => void;
	onRowClick: (entry: SftpEntry) => void;
}

const EntryRow = memo(function EntryRow({
	entry,
	depth,
	isExpanded,
	checked,
	indeterminate,
	isSelected,
	multiSelect,
	onChevron,
	onCheck,
	onRowClick,
}: EntryRowProps) {
	const isDir = entry.type === 'dir';
	return (
		<Box
			onClick={() => onRowClick(entry)}
			sx={{
				display: 'flex',
				alignItems: 'center',
				height: ITEM_HEIGHT,
				pl: `${depth * 16 + 4}px`,
				pr: 1,
				gap: 0.5,
				cursor: 'pointer',
				userSelect: 'none',
				bgcolor: !multiSelect && isSelected ? 'action.selected' : 'transparent',
				'&:hover': {
					bgcolor: !multiSelect && isSelected ? 'action.selected' : 'action.hover',
				},
			}}
		>
			{/* Expand chevron */}
			<Box
				onClick={
					isDir
						? e => {
								e.stopPropagation();
								onChevron(entry.path);
							}
						: undefined
				}
				sx={{
					width: 18,
					flexShrink: 0,
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					color: 'text.secondary',
					borderRadius: 0.5,
					'&:hover': isDir ? { bgcolor: 'action.focus' } : {},
				}}
			>
				{isDir && (isExpanded ? <ExpandMore sx={{ fontSize: 14 }} /> : <ChevronRight sx={{ fontSize: 14 }} />)}
			</Box>

			{/* Checkbox (multi-select only) */}
			{multiSelect && (
				<Checkbox
					size='small'
					checked={checked}
					indeterminate={isDir && indeterminate}
					onChange={e => onCheck(entry.path, e.target.checked)}
					onClick={e => e.stopPropagation()}
					sx={{ p: 0.25, flexShrink: 0 }}
					tabIndex={-1}
				/>
			)}

			{/* Type icon */}
			{isDir ? (
				<Folder sx={{ fontSize: 16, color: 'primary.main', flexShrink: 0 }} />
			) : (
				<InsertDriveFile sx={{ fontSize: 16, color: 'text.secondary', flexShrink: 0 }} />
			)}

			{/* Name */}
			<Typography variant='body2' noWrap sx={{ flexGrow: 1, minWidth: 0 }}>
				{entry.name}
			</Typography>

			{/* File size */}
			{!isDir && entry.size_bytes !== null && (
				<Typography variant='caption' color='text.secondary' sx={{ flexShrink: 0 }}>
					{fmtBytes(entry.size_bytes)}
				</Typography>
			)}
		</Box>
	);
});

// ─── Component ────────────────────────────────────────────────────────────────

interface FileBrowserProps {
	nodeId: number | undefined;
	sftpRoot?: string;
	selected: string[];
	onChange: (paths: string[]) => void;
	multiSelect?: boolean;
	dirsOnly?: boolean;
}

export function FileBrowser({
	nodeId,
	sftpRoot = '/',
	selected,
	onChange,
	multiSelect = true,
	dirsOnly = false,
}: FileBrowserProps) {
	const rootPath = sftpRoot.replace(/\/$/, '') || '/';
	const toItemId = (path: string) => path.replace(/\/$/, '') || rootPath;

	const [dirs, setDirs] = useState<Map<string, DirState>>(new Map());
	const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set([rootPath]));

	const containerRef = useRef<HTMLDivElement>(null);
	const inFlight = useRef(new Set<string>());

	// ── loading ──────────────────────────────────────────────────────────────────
	const loadDir = useCallback(
		async (dirPath: string) => {
			if (nodeId === undefined || inFlight.current.has(dirPath)) return;
			inFlight.current.add(dirPath);
			setDirs(prev => new Map(prev).set(dirPath, { loading: true, entries: [], error: null }));
			try {
				const entries = await nodesApi.browseFiles(nodeId, dirPath);
				setDirs(prev => new Map(prev).set(dirPath, { loading: false, entries, error: null }));
			} catch (e) {
				setDirs(prev =>
					new Map(prev).set(dirPath, {
						loading: false,
						entries: [],
						error: e instanceof Error ? e.message : 'Failed to load',
					}),
				);
			} finally {
				inFlight.current.delete(dirPath);
			}
		},
		[nodeId],
	);

	useEffect(() => {
		setDirs(new Map());
		setExpandedPaths(new Set([rootPath]));
		inFlight.current.clear();
		if (nodeId !== undefined) loadDir(rootPath);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [nodeId, rootPath]);

	// ── nodeMap: flat index of all loaded paths for selection math ─────────────
	const nodeMap = useMemo((): Map<string, MapNode> => {
		const map = new Map<string, MapNode>();
		map.set(rootPath, {
			path: rootPath,
			type: 'dir',
			children: dirs.get(rootPath)?.entries ?? [],
		});
		for (const [, state] of dirs) {
			for (const entry of state.entries) {
				map.set(entry.path, {
					path: entry.path,
					type: entry.type,
					children: entry.type === 'dir' ? (dirs.get(entry.path)?.entries ?? []) : [],
				});
			}
		}
		return map;
	}, [dirs, rootPath]);

	const itemFilter = useCallback((e: SftpEntry) => !dirsOnly || e.type === 'dir', [dirsOnly]);

	const checkedSet = useMemo(() => {
		const result = new Set<string>();
		for (const path of selected) {
			const id = toItemId(path);
			const n = nodeMap.get(id);
			if (!dirsOnly || n?.type !== 'file') result.add(id);
			if (n?.type === 'dir') {
				for (const d of collectDescendants(n, nodeMap)) {
					const dn = nodeMap.get(d);
					if (!dirsOnly || dn?.type === 'dir') result.add(d);
				}
			}
		}
		return result;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selected, nodeMap, dirsOnly, rootPath]);

	const indeterminateSet = useMemo(() => {
		const result = new Set<string>();
		for (const [id, node] of nodeMap) {
			if (node.type !== 'dir' || checkedSet.has(id)) continue;
			const hasChecked = collectDescendants(node, nodeMap).some(d => {
				if (dirsOnly && nodeMap.get(d)?.type !== 'dir') return false;
				return checkedSet.has(d);
			});
			if (hasChecked) result.add(id);
		}
		return result;
	}, [checkedSet, nodeMap, dirsOnly]);

	// ── flat list ─────────────────────────────────────────────────────────────
	const flatItems = useMemo(
		() => buildFlatList(rootPath, dirs, expandedPaths, 0, dirsOnly),
		[rootPath, dirs, expandedPaths, dirsOnly],
	);

	// ── virtualizer ───────────────────────────────────────────────────────────
	const virtualizer = useVirtualizer({
		count: flatItems.length,
		getScrollElement: () => containerRef.current,
		estimateSize: () => ITEM_HEIGHT,
		overscan: 8,
		getItemKey: i => flatKey(flatItems[i]),
	});

	// ── handlers ─────────────────────────────────────────────────────────────

	function toggleExpand(path: string) {
		const needsLoad = !dirs.has(path);
		setExpandedPaths(prev => {
			const next = new Set(prev);
			next.has(path) ? next.delete(path) : next.add(path);
			return next;
		});
		if (needsLoad) loadDir(path);
	}

	function handleToggle(itemId: string, chk: boolean) {
		const canonical = new Set(selected.map(toItemId));
		if (chk) {
			canonical.add(itemId);
			for (const c of [...canonical]) {
				if (isDescendantOf(c, itemId)) canonical.delete(c);
			}
			for (const a of canonical) {
				if (a !== itemId && isDescendantOf(itemId, a)) {
					canonical.delete(itemId);
					break;
				}
			}
		} else {
			if (canonical.has(itemId)) {
				canonical.delete(itemId);
			} else {
				const ancestor = [...canonical].find(a => isDescendantOf(itemId, a));
				if (ancestor) {
					canonical.delete(ancestor);
					const an = nodeMap.get(ancestor);
					if (an) explodeExcept(an, new Set([itemId]), canonical, nodeMap, itemFilter);
				}
			}
		}
		promote(canonical, nodeMap, itemFilter);
		onChange(
			[...canonical].map(id => {
				const n = nodeMap.get(id);
				return n?.type === 'dir' ? id + '/' : id;
			}),
		);
	}

	function handleRowClick(entry: SftpEntry) {
		if (entry.type === 'dir') toggleExpand(entry.path);
		if (!multiSelect) onChange([entry.path]);
	}

	// Stable ref wrappers so memoized EntryRow never sees handler identity changes
	const toggleRef = useRef(handleToggle);
	toggleRef.current = handleToggle;
	const stableToggle = useCallback((path: string, chk: boolean) => toggleRef.current(path, chk), []);

	const expandRef = useRef(toggleExpand);
	expandRef.current = toggleExpand;
	const stableExpand = useCallback((path: string) => expandRef.current(path), []);

	const rowClickRef = useRef(handleRowClick);
	rowClickRef.current = handleRowClick;
	const stableRowClick = useCallback((entry: SftpEntry) => rowClickRef.current(entry), []);

	// ── root row ──────────────────────────────────────────────────────────────
	const rootLoading = dirs.get(rootPath)?.loading ?? true;
	const rootChecked = multiSelect && checkedSet.has(rootPath);
	const rootIndeterminate = multiSelect && !rootChecked && indeterminateSet.has(rootPath);
	const singleSelectedId = !multiSelect && selected.length > 0 ? toItemId(selected[0]) : null;

	if (nodeId === undefined) {
		return (
			<Paper variant='outlined' sx={{ px: 2, py: 3, textAlign: 'center' }}>
				<Typography variant='body2' color='text.secondary'>
					Select a node to browse files.
				</Typography>
			</Paper>
		);
	}

	// ── render ────────────────────────────────────────────────────────────────
	return (
		<Paper variant='outlined' sx={{ overflow: 'hidden' }}>
			{/* Root row — always pinned above the scroll area */}
			<Box
				sx={{
					display: 'flex',
					alignItems: 'center',
					height: ITEM_HEIGHT + 2,
					px: 1,
					gap: 0.5,
					userSelect: 'none',
					borderBottom: 1,
					borderColor: 'divider',
				}}
			>
				<Box sx={{ width: 18, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
					{rootLoading && <CircularProgress size={12} />}
				</Box>
				{multiSelect && (
					<Checkbox
						size='small'
						checked={rootChecked}
						indeterminate={rootIndeterminate}
						onChange={e => handleToggle(rootPath, e.target.checked)}
						onClick={e => e.stopPropagation()}
						sx={{ p: 0.25, flexShrink: 0 }}
						tabIndex={-1}
					/>
				)}
				<Home sx={{ fontSize: 16, flexShrink: 0, color: 'text.secondary' }} />
				<Typography variant='body2' noWrap sx={{ flexGrow: 1, minWidth: 0, fontWeight: 500 }}>
					{rootPath}
				</Typography>
				{flatItems.filter(i => i.kind === 'entry').length > 0 && (
					<Typography variant='caption' color='text.secondary' sx={{ flexShrink: 0 }}>
						{flatItems.filter(i => i.kind === 'entry').length.toLocaleString()} items
					</Typography>
				)}
			</Box>

			{/* Virtualised scroll container */}
			<Box ref={containerRef} sx={{ height: CONTAINER_HEIGHT, overflowY: 'auto' }}>
				{/* Spacer that gives the scrollbar its full travel range */}
				<Box sx={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
					{virtualizer.getVirtualItems().map(vRow => {
						const item = flatItems[vRow.index];

						let content: React.ReactNode;

						if (item.kind === 'skel') {
							const widths = [120, 170, 95] as const;
							content = (
								<Box
									sx={{
										display: 'flex',
										alignItems: 'center',
										height: ITEM_HEIGHT,
										pl: `${item.depth * 16 + 22}px`,
										pr: 1,
									}}
								>
									<Skeleton variant='text' width={widths[item.idx]} height={16} />
								</Box>
							);
						} else if (item.kind === 'error') {
							content = (
								<Box
									sx={{
										height: ITEM_HEIGHT,
										display: 'flex',
										alignItems: 'center',
										pl: `${item.depth * 16 + 22}px`,
										pr: 1,
									}}
								>
									<Typography variant='caption' color='error'>
										{item.msg}
									</Typography>
								</Box>
							);
						} else if (item.kind === 'empty') {
							content = (
								<Box
									sx={{
										height: ITEM_HEIGHT,
										display: 'flex',
										alignItems: 'center',
										pl: `${item.depth * 16 + 22}px`,
										pr: 1,
									}}
								>
									<Typography variant='caption' color='text.secondary'>
										(empty)
									</Typography>
								</Box>
							);
						} else {
							// kind === 'entry'
							content = (
								<EntryRow
									entry={item.entry}
									depth={item.depth}
									isExpanded={item.isExpanded}
									checked={checkedSet.has(item.entry.path)}
									indeterminate={indeterminateSet.has(item.entry.path)}
									isSelected={singleSelectedId === item.entry.path}
									multiSelect={multiSelect}
									onChevron={stableExpand}
									onCheck={stableToggle}
									onRowClick={stableRowClick}
								/>
							);
						}

						return (
							<Box
								key={vRow.key}
								sx={{
									position: 'absolute',
									top: 0,
									left: 0,
									width: '100%',
									transform: `translateY(${vRow.start}px)`,
								}}
							>
								{content}
							</Box>
						);
					})}
				</Box>
			</Box>
		</Paper>
	);
}

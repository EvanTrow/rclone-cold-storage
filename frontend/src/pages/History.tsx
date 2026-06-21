import CloseIcon from '@mui/icons-material/Close';
import { Box, Button, Chip, CircularProgress, Drawer, IconButton, Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, useCallback } from 'react';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DataCard } from '../components/DataCard';
import { jobsApi, runsApi, type Run } from '../lib/api';
import { useIsMobile } from '../lib/useIsMobile';

function statusColor(s: Run['status']): 'success' | 'error' | 'warning' | 'default' {
	if (s === 'success') return 'success';
	if (s === 'failed') return 'error';
	if (s === 'running' || s === 'queued') return 'warning';
	return 'default';
}

function formatBytes(n: number | null): string {
	if (!n) return '—';
	if (n < 1024) return `${n} B`;
	if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`;
	if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
	return `${(n / 1024 ** 3).toFixed(2)} GiB`;
}

function duration(r: Run): string {
	if (!r.started_at) return '—';
	const end = r.finished_at ? new Date(r.finished_at) : new Date();
	const secs = Math.round((end.getTime() - new Date(r.started_at).getTime()) / 1000);
	if (secs < 60) return `${secs}s`;
	if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
	return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function LogViewer({ log, isLive }: { log: string | undefined; isLive: boolean }) {
	const ref = useRef<HTMLPreElement>(null);

	useEffect(() => {
		if (isLive && ref.current) {
			ref.current.scrollTop = ref.current.scrollHeight;
		}
	}, [log, isLive]);

	if (log === undefined) {
		return (
			<Box
				sx={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					height: 96,
					color: 'text.secondary',
					gap: 1,
				}}
			>
				<CircularProgress size={18} />
				<Typography variant='body2'>Loading log…</Typography>
			</Box>
		);
	}

	if (!log) {
		return (
			<Typography variant='body2' color='text.secondary' fontStyle='italic'>
				No log output recorded.
			</Typography>
		);
	}

	return (
		<Box
			ref={ref}
			component='pre'
			sx={{
				fontSize: '0.75rem',
				bgcolor: 'action.hover',
				borderRadius: 1,
				p: 1.5,
				overflowY: 'auto',
				maxHeight: 448,
				whiteSpace: 'pre-wrap',
				wordBreak: 'break-words',
				fontFamily: 'monospace',
				lineHeight: 1.6,
				m: 0,
			}}
		>
			{log}
		</Box>
	);
}

export function History() {
	const qc = useQueryClient();
	const isMobile = useIsMobile();
	const [selected, setSelected] = useState<Run | null>(null);
	const [drawerOpen, setDrawerOpen] = useState(false);
	const [confirmClear, setConfirmClear] = useState(false);

	// Incremental log accumulation — null means "not yet loaded" (show spinner).
	const [localLog, setLocalLog] = useState<string | null>(null);
	const logFromRef = useRef(0);

	const { data: runs, isLoading } = useQuery({
		queryKey: ['runs'],
		queryFn: () => runsApi.list(),
		refetchInterval: 60_000,
	});

	const { data: jobs } = useQuery({
		queryKey: ['jobs'],
		queryFn: jobsApi.list,
	});

	const isLive = selected?.status === 'running' || selected?.status === 'queued';

	// Reset log buffer whenever a different run is opened.
	useEffect(() => {
		setLocalLog(null);
		logFromRef.current = 0;
	}, [selected?.id]);

	// queryFn reads logFromRef at call time so the queryKey stays stable.
	const selectedId = selected?.id;
	const detailQueryFn = useCallback(
		() => runsApi.get(selectedId!, logFromRef.current),
		[selectedId],
	);

	const { data: runDetail } = useQuery({
		queryKey: ['run', selected?.id],
		queryFn: detailQueryFn,
		enabled: !!selected,
		refetchInterval: isLive ? 10_000 : false,
	});

	// Append the incoming delta to the local log buffer and advance the offset.
	useEffect(() => {
		if (!runDetail) return;
		const incoming = runDetail.log_output ?? '';
		setLocalLog((prev) => (prev === null ? incoming : prev + incoming));
		logFromRef.current = runDetail.log_length ?? (logFromRef.current + incoming.length);
	}, [runDetail]);

	useEffect(() => {
		if (!selected || !runs) return;
		const updated = runs.find((r) => r.id === selected.id);
		if (updated && updated.status !== selected.status) setSelected(updated);
	}, [runs, selected]);

	const markAllMut = useMutation({
		mutationFn: runsApi.markAllRead,
		onSuccess: () => qc.invalidateQueries({ queryKey: ['runs'] }),
	});

	const ackMut = useMutation({
		mutationFn: (id: number) => runsApi.markRead(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ['runs'] }),
	});

	const clearMut = useMutation({
		mutationFn: runsApi.clearAll,
		onSuccess: () => qc.invalidateQueries({ queryKey: ['runs'] }),
	});

	const cancelMut = useMutation({
		mutationFn: (id: number) => runsApi.cancel(id),
		onSuccess: () => {
			qc.invalidateQueries({ queryKey: ['runs'] });
			if (selected) qc.invalidateQueries({ queryKey: ['run', selected.id] });
		},
	});

	const unreadCount = runs?.filter((r) => !r.alert_read && r.status === 'failed').length ?? 0;
	const jobMap = Object.fromEntries(jobs?.map((j) => [j.id, j.name]) ?? []);

	function openDrawer(run: Run) {
		setSelected(run);
		setDrawerOpen(true);
		if (!run.alert_read) {
			runsApi.markRead(run.id).then(() => qc.invalidateQueries({ queryKey: ['runs'] }));
		}
	}

	const displayRun = runDetail ?? selected;

	// A failed run whose alert hasn't been acknowledged yet.
	function isUnreadFailure(run: Run) {
		return !run.alert_read && run.status === 'failed';
	}

	// Per-run acknowledge button. stopPropagation so it doesn't also open the
	// row/card drawer (which would acknowledge implicitly anyway).
	function acknowledgeButton(run: Run) {
		const pending = ackMut.isPending && ackMut.variables === run.id;
		return (
			<Button
				size='small'
				variant='outlined'
				color='error'
				disabled={pending}
				startIcon={pending ? <CircularProgress size={12} /> : undefined}
				onClick={(e) => {
					e.stopPropagation();
					ackMut.mutate(run.id);
				}}
			>
				Acknowledge
			</Button>
		);
	}

	return (
		<Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
			<Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
				<Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
					<Typography variant='h5' fontWeight={700}>
						History
					</Typography>
					{unreadCount > 0 && <Chip label={`${unreadCount} unread`} color='error' size='small' variant='outlined' />}
				</Box>
				<Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
					{unreadCount > 0 && (
						<Button
							size='small'
							variant='outlined'
							disabled={markAllMut.isPending}
							startIcon={markAllMut.isPending ? <CircularProgress size={12} /> : undefined}
							onClick={() => markAllMut.mutate()}
						>
							Mark all read
						</Button>
					)}
					{!!runs?.length && (
						<Button
							size='small'
							variant='outlined'
							color='error'
							disabled={clearMut.isPending}
							startIcon={clearMut.isPending ? <CircularProgress size={12} /> : undefined}
							onClick={() => setConfirmClear(true)}
						>
							Clear all
						</Button>
					)}
				</Box>
			</Box>

			{isMobile ? (
				<Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
					{isLoading ? (
						<Typography color='text.secondary' align='center' sx={{ py: 4 }}>
							Loading…
						</Typography>
					) : !runs?.length ? (
						<Typography color='text.secondary' align='center' sx={{ py: 4 }}>
							No runs yet.
						</Typography>
					) : (
						runs.map((run) => (
							<DataCard
								key={run.id}
								onClick={() => openDrawer(run)}
								title={run.job_name ?? (run.job_id != null ? (jobMap[run.job_id] ?? `Job #${run.job_id}`) : "Unknown job")}
								actions={isUnreadFailure(run) ? acknowledgeButton(run) : undefined}
									headerAction={
									<Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
										{isUnreadFailure(run) && <Chip label='unread' size='small' color='error' variant='outlined' />}
										<Chip label={run.status} size='small' variant='outlined' color={statusColor(run.status)} />
									</Box>
								}
								fields={[
									{ label: 'Started', value: run.started_at ? new Date(run.started_at).toLocaleString() : '—' },
									{ label: 'Duration', value: duration(run) },
									{
										label: 'Transferred',
										value: `${formatBytes(run.bytes_transferred)}${run.files_transferred != null ? ` (${run.files_transferred} files)` : ''}`,
									},
								]}
							/>
						))
					)}
				</Box>
			) : (
				<TableContainer component={Paper}>
					<Table aria-label='Run history'>
						<TableHead>
							<TableRow>
								<TableCell>Job</TableCell>
								<TableCell>Status</TableCell>
								<TableCell>Started</TableCell>
								<TableCell>Duration</TableCell>
								<TableCell>Transferred</TableCell>
								<TableCell>Alert</TableCell>
							</TableRow>
						</TableHead>
						<TableBody>
							{isLoading ? (
								<TableRow>
									<TableCell colSpan={6} align='center' sx={{ py: 4, color: 'text.secondary' }}>
										Loading…
									</TableCell>
								</TableRow>
							) : !runs?.length ? (
								<TableRow>
									<TableCell colSpan={6} align='center' sx={{ py: 4, color: 'text.secondary' }}>
										No runs yet.
									</TableCell>
								</TableRow>
							) : (
								runs.map((run) => (
									<TableRow key={run.id} hover sx={{ cursor: 'pointer' }} onClick={() => openDrawer(run)}>
										<TableCell>{run.job_name ?? (run.job_id != null ? (jobMap[run.job_id] ?? `Job #${run.job_id}`) : "Unknown job")}</TableCell>
										<TableCell>
											<Chip label={run.status} size='small' variant='outlined' color={statusColor(run.status)} />
										</TableCell>
										<TableCell>{run.started_at ? new Date(run.started_at).toLocaleString() : '—'}</TableCell>
										<TableCell>{duration(run)}</TableCell>
										<TableCell>
											{formatBytes(run.bytes_transferred)}
											{run.files_transferred != null && ` (${run.files_transferred} files)`}
										</TableCell>
										<TableCell>{isUnreadFailure(run) && acknowledgeButton(run)}</TableCell>
									</TableRow>
								))
							)}
						</TableBody>
					</Table>
				</TableContainer>
			)}

			<Drawer anchor='right' open={drawerOpen} onClose={() => setDrawerOpen(false)} PaperProps={{ sx: { width: { xs: '100%', sm: 520, md: 720, lg: 960, xl: 1200 } } }}>
				<Box sx={{ p: 3, height: '100%', overflowY: 'auto' }}>
					<Box
						sx={{
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'space-between',
							mb: 2.5,
						}}
					>
						<Typography variant='h6'>{selected ? (selected.job_name ?? (selected.job_id != null ? (jobMap[selected.job_id] ?? `Job #${selected.job_id}`) : 'Unknown job')) : 'Run details'}</Typography>
						<IconButton onClick={() => setDrawerOpen(false)}>
							<CloseIcon />
						</IconButton>
					</Box>

					{selected && displayRun && (
						<Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
							<Box
								sx={{
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'space-between',
								}}
							>
								<Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
									<Chip label={displayRun.status} size='small' variant='outlined' color={statusColor(displayRun.status)} />
									{isLive && (
										<Chip
											label={
												<Box
													sx={{
														display: 'flex',
														alignItems: 'center',
														gap: 0.5,
													}}
												>
													<Box
														component='span'
														sx={{
															width: 6,
															height: 6,
															borderRadius: '50%',
															bgcolor: 'warning.main',
															animation: 'pulse 1.5s infinite',
															'@keyframes pulse': {
																'0%, 100%': { opacity: 1 },
																'50%': { opacity: 0.4 },
															},
														}}
													/>
													Live
												</Box>
											}
											size='small'
											color='warning'
											variant='outlined'
										/>
									)}
								</Box>
								{isLive && (
									<Button
										size='small'
										variant='outlined'
										color='error'
										disabled={cancelMut.isPending}
										startIcon={cancelMut.isPending ? <CircularProgress size={12} /> : undefined}
										onClick={() => cancelMut.mutate(displayRun.id)}
									>
										Cancel job
									</Button>
								)}
							</Box>

							<Box
								sx={{
									display: 'grid',
									gridTemplateColumns: 'auto 1fr',
									columnGap: 3,
									rowGap: 1,
									alignItems: 'center',
								}}
							>
								<Typography variant='body2' color='text.secondary'>
									Started
								</Typography>
								<Typography variant='body2'>{displayRun.started_at ? new Date(displayRun.started_at).toLocaleString() : '—'}</Typography>
								<Typography variant='body2' color='text.secondary'>
									Finished
								</Typography>
								<Typography variant='body2'>{displayRun.finished_at ? new Date(displayRun.finished_at).toLocaleString() : '—'}</Typography>
								<Typography variant='body2' color='text.secondary'>
									Duration
								</Typography>
								<Typography variant='body2'>{duration(displayRun)}</Typography>
								<Typography variant='body2' color='text.secondary'>
									Transferred
								</Typography>
								<Typography variant='body2'>
									{formatBytes(displayRun.bytes_transferred)}
									{displayRun.files_transferred != null && ` (${displayRun.files_transferred} files)`}
								</Typography>
								{displayRun.validation_passed !== null && (
									<>
										<Typography variant='body2' color='text.secondary'>
											Validation
										</Typography>
										<Chip label={displayRun.validation_passed ? 'Passed' : 'Failed'} size='small' variant='outlined' color={displayRun.validation_passed ? 'success' : 'error'} />
									</>
								)}
							</Box>

							<Box>
								<Typography variant='subtitle2' gutterBottom>
									Log output
								</Typography>
								<LogViewer log={localLog === null ? undefined : localLog} isLive={isLive} />
							</Box>
						</Box>
					)}
				</Box>
			</Drawer>

			<ConfirmDialog
				open={confirmClear}
				title='Clear run history'
				message='Permanently delete all run history? Active (running or queued) runs are kept. This cannot be undone.'
				confirmLabel='Clear all'
				onConfirm={() => clearMut.mutate()}
				onClose={() => setConfirmClear(false)}
			/>
		</Box>
	);
}

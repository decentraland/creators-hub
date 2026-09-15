import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  LinearProgress,
  MenuItem,
  Select,
  Slider,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from 'decentraland-ui2';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';

import {
  DEFAULT_OPTIMIZE_OPTIONS,
  type OptimizeOptions,
  type TextureCategory,
  type TextureFormat,
} from '/shared/types/optimizer';
import type { Project } from '/shared/types/projects';
import { formatBytes } from '/shared/utils';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { misc, optimizer as optimizerPreload } from '#preload';
import { useDispatch, useSelector } from '#store';
import { useSettings } from '/@/hooks/useSettings';
import { actions } from '/@/modules/store/optimizer';
import { t } from '/@/modules/store/translation/utils';

import { Modal } from '../Modals';
import './styles.css';

function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const TEXTURE_CATEGORIES: TextureCategory[] = ['baseColor', 'normal', 'orm', 'emissive', 'other'];
const FORMATS: TextureFormat[] = ['png', 'jpeg', 'webp'];

// TODO: replace with the published "Optimize models" documentation URL.
const DOCS_URL = 'https://docs.decentraland.org/creator/optimize-models';

function InfoTip({ tip }: { tip: string }) {
  return (
    <Tooltip
      title={tip}
      placement="top"
      arrow
    >
      <InfoOutlinedIcon
        className="info-tip"
        fontSize="small"
        tabIndex={0}
        aria-label={tip}
      />
    </Tooltip>
  );
}

// Text button with a chevron that reveals a block below it, so optional detail (the tool list,
// the per-model table) reads as "more info" rather than as a setting.
function Disclosure({
  open,
  label,
  onToggle,
}: {
  open: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={open ? 'disclosure open' : 'disclosure'}
      aria-expanded={open}
      onClick={onToggle}
    >
      <ExpandMoreIcon fontSize="small" />
      {label}
    </button>
  );
}

// A max-size field, backed by TEXT rather than by the number itself. A `type="number"` input
// reads back as `''` while the creator clears it to retype, `Number('')` is 0, and 0 reaches
// sharp as `resize(null, 0)` — which throws for EVERY texture, failing the whole run under a
// "succeeded" result. Valid input commits as it is typed; anything else is only reverted to the
// last good value on blur, so the field can still be emptied mid-edit.
function SizeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [isFocused, setFocused] = useState(false);

  // Adopt an external change only while the creator does not own the field (coding-standards.md).
  useEffect(() => {
    if (isFocused) return;
    setText(String(value));
  }, [value, isFocused]);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const next = event.target.value;
      setText(next);
      const parsed = Number(next);
      if (next.trim() !== '' && Number.isFinite(parsed) && parsed >= 1) {
        onChange(Math.round(parsed));
      }
    },
    [onChange],
  );

  return (
    <TextField
      size="small"
      type="number"
      label={label}
      value={text}
      onFocus={() => setFocused(true)}
      // Releasing the field lets the effect above put the last committed value back, which is
      // what discards an empty or out-of-range draft.
      onBlur={() => setFocused(false)}
      onChange={handleChange}
    />
  );
}

// Label + info icon, for use as a FormControlLabel `label` or a standalone field label.
function LabelWithInfo({ text, tip }: { text: string; tip: string }) {
  return (
    <span className="label-with-info">
      {text}
      <InfoTip tip={tip} />
    </span>
  );
}

export function OptimizeModal({ project }: { project?: Project | null }) {
  const dispatch = useDispatch();
  const {
    isOpen,
    acknowledged,
    tools,
    installStatus,
    scan,
    scanStatus,
    runStatus,
    revertStatus,
    progress,
    result,
    error,
  } = useSelector(state => state.optimizer);

  const [options, setOptions] = useState<OptimizeOptions>(DEFAULT_OPTIMIZE_OPTIONS);
  const [showDetails, setShowDetails] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const { settings, updateAppSettings } = useSettings();

  const projectPath = project?.path ?? null;
  const isRunning = runStatus === 'loading';
  const isReverting = revertStatus === 'loading';

  // The consent screen lists the pinned toolchain, so fetch that list as soon as the modal opens.
  useEffect(() => {
    if (isOpen) dispatch(actions.loadTools());
  }, [isOpen, dispatch]);

  useEffect(() => {
    if (isOpen) setDontShowAgain(false);
  }, [isOpen]);

  // A creator who asked not to see the disclosure again goes straight to the scan.
  useEffect(() => {
    if (isOpen && !acknowledged && settings.optimizerConsentAcknowledged) {
      dispatch(actions.acknowledge());
    }
  }, [isOpen, acknowledged, settings.optimizerConsentAcknowledged, dispatch]);

  // Nothing is downloaded until the creator has seen the disclosure and continued.
  useEffect(() => {
    if (isOpen && acknowledged && projectPath && tools?.status === 'missing') {
      if (installStatus === 'idle') dispatch(actions.installTools(projectPath));
    }
  }, [isOpen, acknowledged, projectPath, tools?.status, installStatus, dispatch]);

  // Scan the scene only once the tools are on disk — so nothing touches the creator's files
  // before they've decided to proceed and the run can actually happen.
  useEffect(() => {
    if (isOpen && acknowledged && projectPath && tools?.status === 'ready') {
      dispatch(actions.scanProject(projectPath));
    }
  }, [isOpen, acknowledged, projectPath, tools?.status, dispatch]);

  // Stream progress for this scene while the modal is open.
  useEffect(() => {
    if (!isOpen || !projectPath) return;
    const { cleanup } = optimizerPreload.subscribeProgress(projectPath, p =>
      dispatch(actions.setProgress(p)),
    );
    return cleanup;
  }, [isOpen, projectPath, dispatch]);

  const updateMesh = useCallback(
    (patch: Partial<OptimizeOptions['mesh']>) =>
      setOptions(o => ({ ...o, mesh: { ...o.mesh, ...patch } })),
    [],
  );
  const updateTextures = useCallback(
    (patch: Partial<OptimizeOptions['textures']>) =>
      setOptions(o => ({ ...o, textures: { ...o.textures, ...patch } })),
    [],
  );
  const updateSize = useCallback(
    (category: TextureCategory, value: number) =>
      setOptions(o => ({
        ...o,
        textures: { ...o.textures, sizes: { ...o.textures.sizes, [category]: value } },
      })),
    [],
  );

  const handleClose = useCallback(() => {
    if (!isRunning && !isReverting) dispatch(actions.close());
  }, [isRunning, isReverting, dispatch]);

  // MUI calls onClose(event, reason) for the backdrop and Escape; the X passes a click event.
  // Configuring and running a job should not be lost to a stray click beside the dialog, so
  // only the X, Escape and the buttons close it. ui2 types the prop as a plain click handler,
  // so the reason is read off the rest args — a variadic handler is assignable to it as is.
  const handleModalClose = useCallback(
    (...args: unknown[]) => {
      if (args[1] === 'backdropClick') return;
      handleClose();
    },
    [handleClose],
  );

  const handleAcknowledge = useCallback(() => {
    if (dontShowAgain) updateAppSettings({ ...settings, optimizerConsentAcknowledged: true });
    dispatch(actions.acknowledge());
  }, [dontShowAgain, settings, updateAppSettings, dispatch]);

  const handleRun = useCallback(() => {
    if (projectPath) dispatch(actions.runOptimize({ path: projectPath, options }));
  }, [projectPath, options, dispatch]);

  const handleRevert = useCallback(() => {
    if (projectPath) dispatch(actions.revertProject(projectPath));
  }, [projectPath, dispatch]);

  const percent = useMemo(() => {
    if (progress && progress.total > 0)
      return Math.round((progress.current / progress.total) * 100);
    return 0;
  }, [progress]);

  const savings = useMemo(() => {
    if (!result || result.bytesBefore === 0) return { saved: 0, percent: '0.0' };
    const saved = result.bytesBefore - result.bytesAfter;
    return { saved, percent: ((saved / result.bytesBefore) * 100).toFixed(1) };
  }, [result]);

  const details = useMemo(() => {
    const files = result?.files ?? [];
    const counts = { optimized: 0, unchanged: 0, skipped: 0, up_to_date: 0, failed: 0 };
    for (const f of files) counts[f.status]++;
    const saved = (f: (typeof files)[number]) => f.bytesBefore - f.bytesAfter;
    // Failures first (the only rows that need acting on), then most-impactful — what a creator
    // wants to scan.
    const sorted = [...files].sort((a, b) => {
      if ((a.status === 'failed') !== (b.status === 'failed')) {
        return a.status === 'failed' ? -1 : 1;
      }
      return saved(b) - saved(a);
    });
    return { counts, sorted };
  }, [result]);

  if (!isOpen || !project) return null;

  return (
    <Modal
      open={isOpen}
      size="small"
      title={t('optimize.title')}
      onClose={handleModalClose}
    >
      {!acknowledged ? (
        <div className="OptimizeModal consent">
          <Typography
            variant="body2"
            className="subtitle"
          >
            {t('optimize.consent.blurb')}
          </Typography>
          <Disclosure
            open={showTools}
            label={
              showTools
                ? t('optimize.consent.hide_tools')
                : t('optimize.consent.show_tools', { count: tools?.tools.length ?? 0 })
            }
            onToggle={() => setShowTools(v => !v)}
          />
          {showTools && (
            <ul className="tool-list">
              {(tools?.tools ?? []).map(tool => (
                <li key={tool.pkg}>
                  <div className="tool-head">
                    <span className="tool-name">
                      {tool.name} <span className="tool-version">v{tool.version}</span>
                    </span>
                    <span className="tool-links">
                      <button
                        type="button"
                        className="docs-link"
                        onClick={() => misc.openExternal(tool.npm)}
                      >
                        {t('optimize.consent.npm')}
                        <OpenInNewIcon fontSize="inherit" />
                      </button>
                      <button
                        type="button"
                        className="docs-link"
                        onClick={() => misc.openExternal(tool.source)}
                      >
                        {t('optimize.consent.source')}
                        <OpenInNewIcon fontSize="inherit" />
                      </button>
                    </span>
                  </div>
                  <span className="tool-purpose">
                    {t(`optimize.consent.purpose.${tool.purposeKey}`)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Typography
            variant="caption"
            className="consent-note"
          >
            {tools?.status === 'missing'
              ? `${t('optimize.consent.download', { size: tools.downloadSizeMb })} ${t('optimize.consent.note')}`
              : t('optimize.consent.note')}
          </Typography>
          <FormControlLabel
            className="dont-show-again"
            control={
              <Checkbox
                size="small"
                checked={dontShowAgain}
                onChange={e => setDontShowAgain(e.target.checked)}
              />
            }
            label={t('optimize.consent.dont_show_again')}
          />
          <Box className="actions">
            <Button
              variant="contained"
              disabled={!tools}
              onClick={handleAcknowledge}
            >
              {t('optimize.consent.continue')}
            </Button>
            <Button
              variant="outlined"
              onClick={handleClose}
            >
              {t('optimize.consent.cancel')}
            </Button>
          </Box>
        </div>
      ) : tools?.status !== 'ready' ? (
        <div className="OptimizeModal installing">
          <Typography
            variant="body2"
            className="subtitle"
          >
            {t('optimize.tools.installing_blurb')}
          </Typography>
          {installStatus === 'failed' ? (
            <>
              <Typography className="error">
                {t('optimize.tools.failed', { message: error ?? '' })}
              </Typography>
              <Box className="actions">
                <Button
                  variant="contained"
                  onClick={() => projectPath && dispatch(actions.installTools(projectPath))}
                >
                  {t('optimize.tools.retry')}
                </Button>
                <Button
                  variant="outlined"
                  onClick={handleClose}
                >
                  {t('optimize.consent.cancel')}
                </Button>
              </Box>
            </>
          ) : (
            <Box className="progress">
              <LinearProgress variant="indeterminate" />
              <span className="progress-message">
                {progress?.phase === 'install' ? progress.message : t('optimize.tools.installing')}
              </span>
            </Box>
          )}
        </div>
      ) : (
        <div className="OptimizeModal">
          <Typography
            variant="body2"
            className="subtitle"
          >
            {t('optimize.subtitle')}
          </Typography>

          <button
            type="button"
            className="docs-link"
            onClick={() => misc.openExternal(DOCS_URL)}
          >
            {t('optimize.docs_link')}
            <OpenInNewIcon fontSize="inherit" />
          </button>

          {scanStatus === 'succeeded' && scan && (
            <Box className="summary">
              {scan.glbCount === 0 ? (
                <Typography className="empty">{t('optimize.scan.empty')}</Typography>
              ) : (
                <>
                  <span>{t('optimize.scan.glbs', { count: scan.glbCount })}</span>
                  <span>
                    {t('optimize.scan.size', {
                      size: formatBytes(scan.totalBytes),
                      models: formatBytes(scan.glbBytes),
                      textures: formatBytes(scan.textureBytes),
                    })}
                  </span>
                  <span>
                    {t('optimize.scan.textures', {
                      embedded: scan.embeddedTextureCount,
                      external: scan.externalTextureCount,
                    })}
                  </span>
                  {scan.lastOptimizedAt !== null && (
                    <span className="last-optimized">
                      {t('optimize.scan.last_optimized', {
                        date: formatDate(scan.lastOptimizedAt),
                      })}
                    </span>
                  )}
                </>
              )}
            </Box>
          )}

          <Box className="options">
            <Typography variant="h6">{t('optimize.options.mesh.title')}</Typography>
            <FormControlLabel
              control={
                <Switch
                  checked={options.mesh.enabled}
                  onChange={e => updateMesh({ enabled: e.target.checked })}
                />
              }
              label={
                <LabelWithInfo
                  text={t('optimize.options.mesh.enabled')}
                  tip={t('optimize.options.mesh.enabled_tip')}
                />
              }
            />
            <Typography variant="h6">{t('optimize.options.textures.title')}</Typography>
            <FormControlLabel
              control={
                <Switch
                  checked={options.textures.compress}
                  onChange={e => updateTextures({ compress: e.target.checked })}
                />
              }
              label={
                <LabelWithInfo
                  text={t('optimize.options.textures.compress')}
                  tip={t('optimize.options.textures.compress_tip')}
                />
              }
            />
            <FormControlLabel
              control={
                <Switch
                  checked={options.textures.dedup}
                  onChange={e => updateTextures({ dedup: e.target.checked })}
                />
              }
              label={
                <LabelWithInfo
                  text={t('optimize.options.textures.dedup')}
                  tip={t('optimize.options.textures.dedup_tip')}
                />
              }
            />
            <FormControlLabel
              control={
                <Switch
                  checked={options.textures.externalize}
                  onChange={e => updateTextures({ externalize: e.target.checked })}
                />
              }
              label={
                <LabelWithInfo
                  text={t('optimize.options.textures.externalize')}
                  tip={t('optimize.options.textures.externalize_tip')}
                />
              }
            />

            {options.textures.compress && (
              <>
                <Box className="row">
                  <LabelWithInfo
                    text={t('optimize.options.textures.format')}
                    tip={t('optimize.options.textures.format_tip')}
                  />
                  <Select
                    size="small"
                    value={options.textures.format}
                    onChange={e => updateTextures({ format: e.target.value as TextureFormat })}
                  >
                    {FORMATS.map(f => (
                      <MenuItem
                        key={f}
                        value={f}
                      >
                        {f.toUpperCase()}
                      </MenuItem>
                    ))}
                  </Select>
                </Box>

                {options.textures.format !== 'png' && (
                  <Box className="slider">
                    <LabelWithInfo
                      text={t('optimize.options.textures.quality')}
                      tip={t('optimize.options.textures.quality_tip')}
                    />
                    <Slider
                      min={1}
                      max={100}
                      value={options.textures.quality}
                      valueLabelDisplay="auto"
                      onChange={(_, v) => updateTextures({ quality: v as number })}
                    />
                  </Box>
                )}

                <Typography className="sizes-title">
                  <LabelWithInfo
                    text={t('optimize.options.textures.sizes')}
                    tip={t('optimize.options.textures.sizes_tip')}
                  />
                </Typography>
                <Box className="sizes">
                  {TEXTURE_CATEGORIES.map(cat => (
                    <SizeField
                      key={cat}
                      label={t(`optimize.options.textures.${cat}`)}
                      value={options.textures.sizes[cat]}
                      onChange={size => updateSize(cat, size)}
                    />
                  ))}
                </Box>
              </>
            )}
          </Box>

          {isRunning && (
            <Box className="progress">
              <LinearProgress
                variant={progress && progress.total > 0 ? 'determinate' : 'indeterminate'}
                value={percent}
              />
              <span className="progress-message">{progress?.message ?? t('optimize.running')}</span>
            </Box>
          )}

          {error && (runStatus === 'failed' || revertStatus === 'failed') && (
            <Typography className="error">
              {/* `error` is shared, and whichever action failed most recently owns it: both
                  pending reducers clear it, and starting a run resets revertStatus. */}
              {revertStatus === 'failed'
                ? t('optimize.revert_error', { message: error })
                : t('optimize.error', { message: error })}
            </Typography>
          )}

          {result && runStatus === 'succeeded' && (
            <Box className="result">
              <Typography variant="h6">{t('optimize.result.title')}</Typography>
              <span className="saved">
                {t('optimize.result.saved', {
                  saved: formatBytes(savings.saved),
                  percent: savings.percent,
                })}
              </span>
              <span>
                {t('optimize.result.before_after', {
                  before: formatBytes(result.bytesBefore),
                  after: formatBytes(result.bytesAfter),
                })}
              </span>
              <span>{t('optimize.result.glbs_changed', { count: result.glbsChanged })}</span>
              <span>
                {t('optimize.result.textures_extracted', { count: result.texturesExtracted })}
              </span>
              <span>
                {t('optimize.result.textures_deduped', { count: result.texturesDeduped })}
              </span>
              {result.texturesRemoved > 0 && (
                <span>
                  {t('optimize.result.textures_removed', {
                    count: result.texturesRemoved,
                    bytes: formatBytes(result.removedBytes),
                  })}
                </span>
              )}
              {details.counts.up_to_date > 0 && (
                <span className="muted">
                  {t('optimize.result.up_to_date', { count: details.counts.up_to_date })}
                </span>
              )}
              {(details.counts.unchanged > 0 || details.counts.skipped > 0) && (
                <span className="muted">
                  {t('optimize.result.unchanged_skipped', {
                    unchanged: details.counts.unchanged,
                    skipped: details.counts.skipped,
                  })}
                </span>
              )}
              {details.counts.failed > 0 && (
                <span className="failed">
                  {t('optimize.result.failed', { count: details.counts.failed })}
                </span>
              )}
              {result.ignoredFiles.length > 0 && (
                <span
                  className="warning"
                  title={result.ignoredFiles.join('\n')}
                >
                  {t('optimize.result.ignored_files', {
                    count: result.ignoredFiles.length,
                    files: result.ignoredFiles.slice(0, 3).join(', '),
                  })}
                </span>
              )}

              <Disclosure
                open={showDetails}
                label={t(
                  showDetails ? 'optimize.result.hide_details' : 'optimize.result.show_details',
                )}
                onToggle={() => setShowDetails(v => !v)}
              />

              {showDetails && (
                <div className="file-details">
                  {details.sorted.map(f => {
                    const saved = f.bytesBefore - f.bytesAfter;
                    const pct =
                      f.bytesBefore > 0 ? ((saved / f.bytesBefore) * 100).toFixed(0) : '0';
                    return (
                      <div
                        className="file-row"
                        key={f.file}
                      >
                        <span
                          className="file-name"
                          title={f.file}
                        >
                          {f.file}
                        </span>
                        {f.status === 'optimized' ? (
                          <span className="file-size">
                            {formatBytes(f.bytesBefore)} → {formatBytes(f.bytesAfter)}
                            <em className="file-pct"> −{pct}%</em>
                          </span>
                        ) : (
                          <span
                            className={f.status === 'failed' ? 'file-status failed' : 'file-status'}
                            title={f.error}
                          >
                            {t(`optimize.result.status.${f.status}`)}
                          </span>
                        )}
                        <span className="file-badges">
                          {f.texturesExtracted > 0 && <em>+{f.texturesExtracted} tex</em>}
                          {f.texturesDeduped > 0 && <em>−{f.texturesDeduped} dup</em>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Box>
          )}

          <Box className="actions">
            {result && runStatus === 'succeeded' ? (
              <>
                <Button
                  variant="contained"
                  onClick={handleClose}
                >
                  {t('optimize.done')}
                </Button>
                <Button
                  variant="text"
                  disabled={!projectPath}
                  onClick={handleRun}
                >
                  {t('optimize.run_again')}
                </Button>
              </>
            ) : (
              <Button
                variant="contained"
                disabled={isRunning || !projectPath || scan?.glbCount === 0}
                onClick={handleRun}
              >
                {isRunning ? t('optimize.running') : t('optimize.run')}
              </Button>
            )}
            {scan?.hasBackup && (
              <Button
                variant="outlined"
                disabled={isRunning || isReverting}
                onClick={handleRevert}
              >
                {isReverting ? t('optimize.reverting') : t('optimize.revert')}
              </Button>
            )}
          </Box>
        </div>
      )}
    </Modal>
  );
}

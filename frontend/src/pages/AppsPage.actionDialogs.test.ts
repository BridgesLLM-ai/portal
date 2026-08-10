import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appsSource = readFileSync(new URL('./AppsPage.tsx', import.meta.url), 'utf8');

function sourceBetween(startMarker: string, endMarker: string): string {
  const start = appsSource.indexOf(startMarker);
  const end = appsSource.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`Missing AppsPage source markers: ${startMarker} -> ${endMarker}`);
  return appsSource.slice(start, end);
}

const createProjectDialog = sourceBetween('{/* Create Project Dialog */}', '{/* New File Dialog */}');
const newEntryDialog = sourceBetween('{/* New File Dialog */}', '{/* Upload Files Dialog */}');
const uploadFilesDialog = sourceBetween('{/* Upload Files Dialog */}', '{/* Delete Confirmation */}');
const revertCommitDialog = sourceBetween('{/* Revert Confirmation Modal */}', '{/* Side-by-Side Diff Viewer Modal */}');
const commitDiffDialog = sourceBetween('{/* Side-by-Side Diff Viewer Modal */}', '{/* Progress Notification for deploy/install */}');
const fullscreenEditorDialog = sourceBetween('{/* Fullscreen Editor Overlay */}', '{/* File Search Dialog (Ctrl+P) */}');
const fileSearchDialog = sourceBetween('{/* File Search Dialog (Ctrl+P) */}', '{/* Top Bar */}');
const responsiveProjectSidebar = sourceBetween('{/* Sidebar - Project List & File Tree */}', '{/* Main Content Area */}');
const responsiveProjectPanels = sourceBetween('{/* Right Panel - Git / Share / Activity */}', '{/* Confirm Delete Share Link */}');
const createProjectHandler = sourceBetween('const createProject = async () => {', 'const requestDeleteProject');
const createShareHandler = sourceBetween('const createShareLink = async () => {', 'const toggleShareActive');
const loadSharesHandler = sourceBetween('const loadShares = useCallback', 'const retryLoadShares');
const selectProjectHandler = sourceBetween('const selectProject = useCallback', 'useEffect(() => {\n    if (!projectDeepLinkPresent');
const toggleShareHandler = sourceBetween('const toggleShareActive = async (linkId: string) => {', '// Download project');
const shareEmailHandler = sourceBetween('const sendShareEmail = async (linkId: string) => {', 'const deleteSharePermanently');
const deleteShareHandler = sourceBetween('const deleteSharePermanently = async () => {', 'const makeSharePublic');
const makePublicHandler = sourceBetween('const makeSharePublic = async () => {', 'const copyToClipboard');
const shareConfirmationDialogs = sourceBetween('{/* Confirm Delete Share Link */}', '{/* Project Chat Panel */}');

describe('AppsPage action dialog ownership', () => {
  it('routes all three centered action dialogs through the body-owned modal foundation', () => {
    expect(appsSource).toContain("import ViewportModal from '../components/ViewportModal';");
    expect(appsSource.match(/<ViewportModal\b/g)).toHaveLength(10);

    expect(fullscreenEditorDialog).toContain('open={editorFullscreen && !!openFile}');
    expect(fullscreenEditorDialog).toContain('initialFocusRef={fullscreenExitButtonRef}');
    expect(fileSearchDialog).toContain('open={showFileSearch && !!selectedProject}');
    expect(fileSearchDialog).toContain('initialFocusRef={fileSearchInputRef}');

    expect(createProjectDialog).toContain('open={showCreate}');
    expect(createProjectDialog).toContain('dismissible={!(creating || zipUploading)}');
    expect(createProjectDialog).toContain('initialFocusRef={createProjectNameInputRef}');

    expect(newEntryDialog).toContain('open={showNewFile}');
    expect(newEntryDialog).toContain('dismissible={!creatingEntry}');
    expect(newEntryDialog).toContain('initialFocusRef={newProjectEntryInputRef}');

    expect(uploadFilesDialog).toContain('open={showUploadDialog && !!selectedProject}');
    expect(uploadFilesDialog).toContain('dismissible={!uploadingFiles}');
    expect(uploadFilesDialog).toContain('initialFocusRef={uploadDestinationSelectRef}');

    expect(revertCommitDialog).toContain('open={!!revertTarget}');
    expect(revertCommitDialog).toContain('dismissible={!reverting}');
    expect(revertCommitDialog).toContain('initialFocusRef={revertCancelButtonRef}');

    expect(commitDiffDialog).toContain('open={!!commitDiff}');
    expect(commitDiffDialog).toContain('initialFocusRef={commitDiffCloseButtonRef}');

    for (const dialog of [fullscreenEditorDialog, fileSearchDialog, createProjectDialog, newEntryDialog, uploadFilesDialog, revertCommitDialog, commitDiffDialog]) {
      expect(dialog).not.toContain('<AnimatePresence>');
      expect(dialog).not.toContain('fixed inset-0');
    }

    expect(appsSource.match(/aria-label="Close commit diff"/g)).toHaveLength(1);
    expect(appsSource.match(/renderDiff\(commitDiff\.diff\)/g) || []).toHaveLength(0);
  });

  it('routes every mobile workspace panel through the shared modal owner', () => {
    expect(responsiveProjectSidebar).toContain('<ResponsiveProjectSidebar');
    expect(responsiveProjectSidebar).not.toContain('fixed inset-0');
    expect(responsiveProjectSidebar).not.toContain("isMobile ? 'fixed left-0");

    expect(responsiveProjectPanels.match(/<ResponsiveProjectPanel\b/g)).toHaveLength(6);
    expect(responsiveProjectPanels).toContain('mobileLabel="Project Git panel"');
    expect(responsiveProjectPanels).toContain('mobileLabel="Project analysis results"');
    expect(responsiveProjectPanels).toContain('mobileLabel="Project deployment recovery"');
    expect(responsiveProjectPanels).toContain('mobileLabel="Project deployment controls"');
    expect(responsiveProjectPanels).toContain('mobileLabel="Project activity panel"');
    expect(responsiveProjectPanels).toContain('mobileLabel="Project sharing panel"');
    expect(responsiveProjectPanels).not.toContain('fixed inset-0 z-50');
  });

  it('keeps one stable busy primary control in each dialog', () => {
    expect(createProjectDialog.match(/onClick=\{createProject\}/g)).toHaveLength(1);
    expect(createProjectDialog).toContain('aria-busy={creating || zipUploading}');
    expect(createProjectDialog).toContain("? 'Uploading project…'");
    expect(createProjectDialog).toContain("? 'Cloning project…' : 'Creating project…'");

    expect(newEntryDialog.match(/onClick=\{createNewFile\}/g)).toHaveLength(1);
    expect(newEntryDialog).toContain('aria-busy={creatingEntry}');
    expect(newEntryDialog).toContain('`Creating ${newFileIsDir ? \'folder\' : \'file\'}…`');

    expect(uploadFilesDialog.match(/onClick=\{handleUploadFiles\}/g)).toHaveLength(1);
    expect(uploadFilesDialog).toContain('aria-busy={uploadingFiles}');
    expect(uploadFilesDialog).toContain('Uploading files…');

    expect(revertCommitDialog.match(/onClick=\{handleRevert\}/g)).toHaveLength(1);
    expect(revertCommitDialog).toContain('aria-busy={reverting}');
    expect(revertCommitDialog).toContain('Reverting…');

    expect(fullscreenEditorDialog).toContain('aria-busy={saving}');
    expect(fullscreenEditorDialog).toContain("{saving ? 'Saving…' : 'Save'}");
    expect(appsSource.match(/\{editorElement\}/g)).toHaveLength(1);
  });

  it('enforces the same create-project prerequisites in the handler as the button', () => {
    expect(createProjectHandler).toContain("const requestedName = newName.trim();");
    expect(createProjectHandler).toContain("const requestedCloneUrl = cloneUrl.trim();");
    expect(createProjectHandler).toContain("if (createMode === 'clone' && !requestedCloneUrl) return;");
    expect(createProjectHandler).toContain('projectsAPI.clone(requestedCloneUrl, requestedName)');
  });

  it('keeps share email, deletion, and public exposure actions single-flight and locally owned', () => {
    expect(appsSource).toContain('const shareActionOwnerRef = useRef<');
    expect(createShareHandler).toContain('shareActionOwnerRef.current');
    expect(toggleShareHandler).toContain('shareActionOwnerRef.current');
    expect(shareEmailHandler).toContain('shareEmailInFlightRef.current');
    expect(shareEmailHandler).toContain('shareActionOwnerRef.current');
    expect(shareEmailHandler).toContain('const request = { projectName: selectedProject, linkId, recipientEmail };');
    expect(shareEmailHandler).toContain('setShareEmailError(extracted.message);');

    expect(deleteShareHandler).toContain('shareDeleteInFlightRef.current');
    expect(deleteShareHandler).toContain('const request = { projectName: selectedProject, linkId: pendingDeleteShare };');
    expect(deleteShareHandler).toContain('setShareDeleteError(extracted.message);');

    expect(makePublicHandler).toContain('shareMakePublicInFlightRef.current');
    expect(makePublicHandler).toContain('const request = { projectName: selectedProject, linkId: confirmPublicId };');
    expect(makePublicHandler).toContain('setShareMakePublicError(extracted.message);');

    expect(shareConfirmationDialogs).toContain('busy={shareDeleteBusy}');
    expect(shareConfirmationDialogs).toContain('error={shareDeleteError}');
    expect(shareConfirmationDialogs).toContain('busy={shareMakePublicBusy}');
    expect(shareConfirmationDialogs).toContain('error={shareMakePublicError}');
    expect(responsiveProjectPanels).toContain('<fieldset disabled={shareActionActive || Boolean(shareRefreshError)}');
    expect(responsiveProjectPanels).toContain('disabled={shareActionActive || shareEmailSuccess === link.id}');
    expect(responsiveProjectPanels).toContain('aria-busy={shareEmailSending}');
    expect(responsiveProjectPanels).toContain('role="alert"');
  });

  it('keeps visitor-slot and shared API throttle controls honest and bounded', () => {
    expect(createShareHandler).toContain("Password must be at most 72 UTF-8 bytes");
    expect(createShareHandler).toContain("Visitor slots must be a whole number from 1 to 1,000,000");
    expect(createShareHandler).toContain("API request limit must be a whole number from 1 to 1,000,000");
    expect(createShareHandler).toContain('rateLimitMaxRequests,');
    expect(createShareHandler).toContain('rateLimitWindowSeconds: request.rateLimitWindowSeconds');
    expect(toggleShareHandler).toContain('visitor slot limit cannot be reactivated');

    expect(responsiveProjectPanels).toContain('aria-label="Visitor slot presets"');
    expect(responsiveProjectPanels).toContain('72 UTF-8 bytes maximum');
    expect(responsiveProjectPanels).toContain('id="share-password-byte-error" role="alert"');
    expect(responsiveProjectPanels).toContain('id="share-password-mismatch-error" role="alert"');
    expect(responsiveProjectPanels).toContain("' share-password-byte-error'");
    expect(responsiveProjectPanels).toContain("'share-password-mismatch-error'");
    expect(responsiveProjectPanels).toContain('aria-invalid={shareMaxUsesInvalid}');
    expect(responsiveProjectPanels).toContain('aria-invalid={shareRateLimitMaxRequestsInvalid}');
    expect(responsiveProjectPanels).toContain('aria-label="Limit share link API requests"');
    expect(responsiveProjectPanels).toContain('Each slot grants one browser up to 30 days of access while the link remains active.');
    expect(responsiveProjectPanels).toContain('Counts dynamic API requests only; static files are excluded.');
    expect(responsiveProjectPanels).toContain("'Unlimited API requests'");
    expect(responsiveProjectPanels).toContain('id="share-create-error" role="alert"');
  });

  it('gives share reads monotonic ownership and rechecks it after the project autosave barrier', () => {
    expect(appsSource).toContain('const shareLoadGenerationRef = useRef(0);');
    expect(loadSharesHandler).toContain('const loadGeneration = ++shareLoadGenerationRef.current;');
    expect(loadSharesHandler).toContain('shareLoadGenerationRef.current === loadGeneration');
    expect(loadSharesHandler.match(/if \(!ownsShareReadback\(\)\) return false;/g)).toHaveLength(2);

    const autosaveBarrier = selectProjectHandler.indexOf('await flushPendingAutoSave();');
    const postBarrierShareCheck = selectProjectHandler.indexOf(
      'if (projectOperationRef.current || deleteInFlightRef.current || isShareActionInFlight()) return;',
      autosaveBarrier,
    );
    expect(autosaveBarrier).toBeGreaterThan(-1);
    expect(postBarrierShareCheck).toBeGreaterThan(autosaveBarrier);
  });

});

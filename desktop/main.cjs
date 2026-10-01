// Muster desktop app: a project picker, then the dashboard of the chosen project in its own window.
// The app drives the same CLI as the terminal (`muster up` / `muster down`), so behaviour is identical.
const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HOME = path.resolve(__dirname, '..');
const CLI = path.join(HOME, 'bin', 'muster.js');
const ICON = path.join(__dirname, 'muster.ico');
const SETTINGS = () => path.join(app.getPath('userData'), 'settings.json');

app.setAppUserModelId('com.obiwayne.muster');
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let current = null; // { root, name, url }
let quitting = false;

// ---------------------------------------------------------------- settings (recent projects, close behaviour)

function loadSettings() {
  try {
    return { recent: [], onClose: 'ask', ...JSON.parse(fs.readFileSync(SETTINGS(), 'utf8')) };
  } catch {
    return { recent: [], onClose: 'ask' };
  }
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS()), { recursive: true });
  fs.writeFileSync(SETTINGS(), JSON.stringify(s, null, 2));
}

function remember(root) {
  const s = loadSettings();
  s.recent = [root, ...s.recent.filter((r) => r.toLowerCase() !== root.toLowerCase())].slice(0, 12);
  saveSettings(s);
}

// ---------------------------------------------------------------- node + CLI

// The orchestrator needs the system Node (node-pty is built for it, not for Electron's runtime).
function findNode() {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['node'], { encoding: 'utf8' });
    return out.split(/\r?\n/).find((l) => l.trim()) || null;
  } catch {
    return null;
  }
}

function cli(args, cwd) {
  return new Promise((resolve) => {
    const node = findNode();
    if (!node) return resolve({ ok: false, out: 'Node.js was not found on PATH. Install Node 22+ and try again.' });
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('MUSTER_') || k.startsWith('ELECTRON_')) delete env[k];
    env.NO_COLOR = '1';
    execFile(node.trim(), [CLI, ...args], { cwd, env, windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() });
    });
  });
}

function serverPort(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, '.muster', 'server.json'), 'utf8')).port;
  } catch {
    return null;
  }
}

async function isRunning(root) {
  const port = serverPort(root);
  if (!port) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- windows

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#111113',
    title: 'Muster',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.on('close', onClose);
  if (process.platform === 'win32') {
    // Taskbar pins relaunch through the hidden launcher (rebuild check, no console), not bare electron.exe.
    win.setAppDetails({
      appId: 'com.obiwayne.muster',
      appIconPath: ICON,
      appIconIndex: 0,
      relaunchCommand: `"${path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe')}" "${path.join(HOME, 'scripts', 'launch.vbs')}"`,
      relaunchDisplayName: 'Muster',
    });
  }
  // Links that leave the dashboard open in the browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = url.startsWith('file:') || (current && url.startsWith(current.url));
    if (!allowed) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });
  showPicker();
}

function showPicker() {
  current = null;
  win.setTitle('Muster');
  void win.loadFile(path.join(__dirname, 'picker.html'));
  buildMenu();
}

// Ask the CLI whether the folder is ready; if not, offer to set it up (local git only, nothing is uploaded).
async function confirmSetup(dir) {
  const r = await cli(['init', '--inspect'], dir);
  let info;
  try {
    info = JSON.parse(r.out);
  } catch {
    return { ok: false, error: r.out || `Could not look at ${dir}.` };
  }
  if (info.state === 'ready') return { ok: true, root: info.root, create: false };
  const name = path.basename(info.root);
  let detail = `${name} isn't set up for Muster yet. Muster will make it a local git repo and commit the files that are there now. Nothing is uploaded to GitHub.`;
  if (info.large) detail += `

Heads up: that is ${info.files.toLocaleString()} files (${Math.round(info.bytes / 1048576).toLocaleString()} MB), more than usual. The first commit may take a while.`;
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Set up this folder?',
    message: `Set up ${name} for Muster?`,
    detail,
    buttons: ['Set up and open', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return { ok: false, canceled: true };
  return { ok: true, root: info.root, create: true };
}

async function openProject(dir) {
  const c = await confirmSetup(dir);
  if (!c.ok) return c;
  const root = c.root.replace(/\//g, path.sep);
  const r = await cli(['up', '--no-ui', ...(c.create ? ['--create'] : [])], root);
  const port = serverPort(root);
  if (!r.ok || !port) return { ok: false, error: r.out || 'Muster did not start. See .muster/logs/orchestrator.log in the project.' };
  remember(root);
  current = { root, name: path.basename(root), url: `http://127.0.0.1:${port}/` };
  win.setTitle(`Muster · ${current.name}`);
  await win.loadURL(current.url);
  buildMenu();
  return { ok: true };
}

async function stopProject(root, clean = false) {
  return cli(['down', ...(clean ? ['--clean'] : [])], root);
}

let askingClose = false;

// The close prompt: a small frameless window styled like the app (a native message box looks foreign).
function askClose(project) {
  return new Promise((resolve) => {
    const [w, h] = [520, 200];
    const b = win.getBounds();
    const dlg = new BrowserWindow({
      parent: win,
      modal: true,
      width: w,
      height: h,
      x: Math.round(b.x + (b.width - w) / 2),
      y: Math.round(b.y + (b.height - h) / 2),
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      transparent: true,
      backgroundColor: '#00000000',
      show: false,
      skipTaskbar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
    });
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('muster:closeChoice', onChoice);
      if (!dlg.isDestroyed()) dlg.destroy();
      resolve(r);
    };
    const onChoice = (event, r) => {
      if (event.sender === dlg.webContents) finish(r ?? { choice: 'cancel' });
    };
    ipcMain.on('muster:closeChoice', onChoice);
    dlg.on('closed', () => finish({ choice: 'cancel' }));
    dlg.once('ready-to-show', () => dlg.show());
    void dlg.loadFile(path.join(__dirname, 'close-dialog.html'), { query: { project } });
  });
}

// Closing the window: stop the crew, or leave it working in the background.
async function onClose(e) {
  if (quitting || !current) return;
  e.preventDefault();
  if (askingClose) return;
  let choice = loadSettings().onClose;
  if (choice === 'ask') {
    askingClose = true;
    const r = await askClose(current.name).finally(() => (askingClose = false));
    if (r.choice !== 'stop' && r.choice !== 'keep') return;
    choice = r.choice;
    if (r.remember) saveSettings({ ...loadSettings(), onClose: choice });
  }
  if (choice === 'stop') {
    win.setTitle(`Muster · stopping ${current.name}…`);
    await stopProject(current.root);
  }
  quitting = true;
  win.close();
}

// ---------------------------------------------------------------- menu

function buildMenu() {
  const s = loadSettings();
  const recent = s.recent.slice(0, 8).map((root) => ({ label: root, click: () => void openProject(root) }));
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open project…', accelerator: 'CmdOrCtrl+O', click: () => void chooseAndOpen() },
        { label: 'Open recent', submenu: recent.length ? recent : [{ label: 'No recent projects', enabled: false }] },
        { label: 'Switch project', accelerator: 'CmdOrCtrl+Shift+O', click: () => showPicker() },
        { type: 'separator' },
        { label: 'Stop the crew', enabled: !!current, click: async () => {
          if (!current) return;
          const root = current.root;
          await stopProject(root);
          showPicker();
        } },
        { label: 'Stop and clean merged worktrees', enabled: !!current, click: async () => {
          if (!current) return;
          const root = current.root;
          await stopProject(root, true);
          showPicker();
        } },
        { type: 'separator' },
        { label: 'Open project folder', enabled: !!current, click: () => current && shell.openPath(current.root) },
        { label: 'Open dashboard in browser', enabled: !!current, click: () => current && shell.openExternal(current.url) },
        { type: 'separator' },
        { label: 'Ask before closing', type: 'radio', checked: s.onClose === 'ask', click: () => saveSettings({ ...loadSettings(), onClose: 'ask' }) },
        { label: 'Stop the crew when closing', type: 'radio', checked: s.onClose === 'stop', click: () => saveSettings({ ...loadSettings(), onClose: 'stop' }) },
        { label: 'Keep the crew running when closing', type: 'radio', checked: s.onClose === 'keep', click: () => saveSettings({ ...loadSettings(), onClose: 'keep' }) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function chooseAndOpen() {
  const r = await dialog.showOpenDialog(win, { title: 'Open a project for Muster', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  const res = await openProject(r.filePaths[0]);
  if (!res.ok && !res.canceled) await dialog.showMessageBox(win, { type: 'error', title: 'Could not open project', message: res.error });
  return res;
}

// ---------------------------------------------------------------- the user's name
// Same file as src/core/user.ts: one name per OS user, shared by every project and the CLI.
function userFile() {
  const base = process.env.MUSTER_SECRETS_DIR
    ? path.resolve(process.env.MUSTER_SECRETS_DIR)
    : process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local'), 'muster')
      : path.join(require('node:os').homedir(), '.muster');
  return path.join(base, 'user.json');
}

function readUserName() {
  try {
    const name = JSON.parse(fs.readFileSync(userFile(), 'utf8')).name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

function writeUserName(name) {
  const clean = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || null;
  fs.mkdirSync(path.dirname(userFile()), { recursive: true });
  fs.writeFileSync(userFile(), JSON.stringify({ name: clean }, null, 2));
  return clean;
}

// ---------------------------------------------------------------- picker IPC
ipcMain.handle('muster:getName', () => readUserName());

// ---------------------------------------------------------------- dashboard project switcher IPC
// Only the window's own dashboard can call these (the preload exposes them to localhost pages only).
const fromWindow = (event) => win && event.sender === win.webContents;
ipcMain.handle('app:projects', async (event) => {
  if (!fromWindow(event)) return null;
  const { recent } = loadSettings();
  const list = await Promise.all(
    recent.filter((r) => fs.existsSync(r)).map(async (root) => ({ root, name: path.basename(root), running: await isRunning(root) })),
  );
  return { current: current?.root ?? null, projects: list };
});
ipcMain.handle('app:switch', async (event, root) => {
  if (!fromWindow(event)) return { ok: false, error: 'not allowed' };
  if (current && String(root).toLowerCase() === current.root.toLowerCase()) return { ok: true };
  const r = await openProject(String(root)); // the project being left keeps its crew running
  if (!r.ok && !r.canceled) await dialog.showMessageBox(win, { type: 'error', title: 'Could not open project', message: r.error });
  return r;
});
ipcMain.handle('app:openFolder', (event) => (fromWindow(event) ? chooseAndOpen() : null));
ipcMain.handle('app:picker', (event) => {
  if (fromWindow(event)) showPicker();
});
ipcMain.handle('app:stopCurrent', async (event) => {
  if (!fromWindow(event) || !current) return;
  const root = current.root;
  await stopProject(root);
  showPicker();
});
// ---------------------------------------------------------------- start a new app / rename the project folder

const slugify = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

// Parent folder for new apps: asked once, then remembered as newAppDir.
ipcMain.handle('muster:newAppDir', () => {
  const dir = loadSettings().newAppDir;
  return dir && fs.existsSync(dir) ? dir : null;
});
ipcMain.handle('muster:pickNewAppDir', async () => {
  const s = loadSettings();
  const r = await dialog.showOpenDialog(win, {
    title: 'Where should new apps be created?',
    defaultPath: s.newAppDir && fs.existsSync(s.newAppDir) ? s.newAppDir : undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  saveSettings({ ...s, newAppDir: r.filePaths[0] });
  return r.filePaths[0];
});
ipcMain.handle('muster:newApp', async (_e, { idea, title, dir } = {}) => {
  const text = String(idea ?? '').trim();
  const parent = String(dir ?? '').trim();
  if (!text) return { ok: false, error: 'Describe what you want to build.' };
  if (!parent || !fs.existsSync(parent)) return { ok: false, error: 'Choose a parent folder that exists.' };
  const name = String(title ?? '').trim();
  const before = new Set(fs.readdirSync(parent));
  const r = await cli(['new', text, '--dir', parent, ...(name ? ['--title', name] : []), '--no-open'], parent);
  if (!r.ok) return { ok: false, error: r.out || 'muster new failed.' };
  // `muster new` prints the project folder; fall back to the one folder it added.
  const printed = r.out.split(/\r?\n/).map((l) => l.trim().replace(/^["']|["']$/g, '')).reverse().find((l) => path.isAbsolute(l) && fs.existsSync(l));
  const added = fs.readdirSync(parent).filter((n) => !before.has(n));
  const root = printed || (added.length === 1 ? path.join(parent, added[0]) : null);
  if (!root) return { ok: false, error: `The app was created but its folder was not found in ${parent}. Open it with "Open a project folder".` };
  return openProject(root);
});

ipcMain.handle('app:renameProject', async (event, newName) => {
  if (!fromWindow(event) || !current) return { ok: false, error: 'not allowed' };
  const slug = slugify(newName);
  if (!slug) return { ok: false, error: 'Enter a name with letters or digits.' };
  const oldRoot = current.root;
  const newRoot = path.join(path.dirname(oldRoot), slug);
  if (newRoot.toLowerCase() === oldRoot.toLowerCase()) return { ok: true };
  if (fs.existsSync(newRoot)) return { ok: false, error: `${newRoot} already exists.` };
  const c = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Rename folder', 'Cancel'], defaultId: 0, cancelId: 1, title: 'Rename project folder',
    message: `Rename the folder to "${slug}"?`,
    detail: `${oldRoot}\n→ ${newRoot}\n\nThe crew stops, the folder is renamed, git worktrees are repaired and the project reopens.`,
  });
  if (c.response !== 0) return { ok: false, canceled: true };
  await stopProject(oldRoot);
  try {
    fs.renameSync(oldRoot, newRoot);
  } catch (err) {
    const r = await openProject(oldRoot);
    return { ok: false, error: `Could not rename the folder (is something else using it?): ${err.message}${r.ok ? '' : `\n${r.error}`}` };
  }
  try {
    // Worktrees record absolute paths in both directions; repair needs the moved worktrees listed.
    const wts = path.join(newRoot, '.muster', 'worktrees');
    const dirs = fs.existsSync(wts) ? fs.readdirSync(wts).map((d) => path.join(wts, d)).filter((d) => fs.existsSync(path.join(d, '.git'))) : [];
    execFileSync('git', ['worktree', 'repair', ...dirs], { cwd: newRoot, windowsHide: true });
  } catch (err) {
    // Repair is best effort; the rename itself is done, so carry on and say so.
    console.error('git worktree repair failed:', err.message);
  }
  const s = loadSettings();
  s.recent = s.recent.filter((r) => r.toLowerCase() !== oldRoot.toLowerCase());
  saveSettings(s);
  const r = await openProject(newRoot);
  if (!r.ok) {
    await dialog.showMessageBox(win, { type: 'error', title: 'Renamed, but could not reopen', message: r.error });
    showPicker();
  }
  return r;
});
ipcMain.handle('app:openProjectFolder', (event) => {
  if (fromWindow(event) && current) void shell.openPath(current.root);
});
ipcMain.handle('muster:setName', (_e, name) => writeUserName(name));

ipcMain.handle('muster:recent', async () => {
  const { recent } = loadSettings();
  return Promise.all(
    recent.filter((r) => fs.existsSync(r)).map(async (root) => ({ root, name: path.basename(root), running: await isRunning(root) })),
  );
});
ipcMain.handle('muster:choose', () => chooseAndOpen());
ipcMain.handle('muster:open', (_e, root) => openProject(String(root)));
ipcMain.handle('muster:forget', (_e, root) => {
  const s = loadSettings();
  s.recent = s.recent.filter((r) => r !== root);
  saveSettings(s);
});
ipcMain.handle('muster:stop', (_e, root) => stopProject(String(root)));

// ---------------------------------------------------------------- lifecycle

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

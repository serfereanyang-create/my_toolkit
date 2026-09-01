const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zcodeDesktop', {
  version: '0.1.0',
  workspace: {
    open: () => ipcRenderer.invoke('workspace.open'),
    setRoot: (root) => ipcRenderer.invoke('workspace.setRoot', root),
    restore: () => ipcRenderer.invoke('workspace.restore'),
    getTree: (relativePath) => ipcRenderer.invoke('workspace.getTree', relativePath),
  },
  fs: {
    read: (relativePath) => ipcRenderer.invoke('fs.read', relativePath),
    write: (relativePath, content) => ipcRenderer.invoke('fs.write', relativePath, content),
    saveTempImage: (filename, base64Data) => ipcRenderer.invoke('fs.saveTempImage', filename, base64Data),
  },
  editor: {
    readFile: (absolutePath) => ipcRenderer.invoke('editor.readFile', absolutePath),
    saveFile: (absolutePath, content) => ipcRenderer.invoke('editor.saveFile', absolutePath, content),
    watchFile: (absolutePath) => ipcRenderer.invoke('editor.watchFile', absolutePath),
    unwatchFile: (absolutePath) => ipcRenderer.invoke('editor.unwatchFile', absolutePath),
    stat: (absolutePath) => ipcRenderer.invoke('editor.stat', absolutePath),
    onFileChanged: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('editor.fileChanged', listener);
      return () => ipcRenderer.removeListener('editor.fileChanged', listener);
    },
  },
  settings: {
    get: () => ipcRenderer.invoke('settings.get'),
    set: (next) => ipcRenderer.invoke('settings.set', next),
  },
  secrets: {
    setApiKey: (providerId, apiKey) => ipcRenderer.invoke('secrets.setApiKey', providerId, apiKey),
    hasApiKey: (providerId) => ipcRenderer.invoke('secrets.hasApiKey', providerId),
  },
  connectivity: {
    test: (providerId) => ipcRenderer.invoke('connectivity.test', providerId),
  },
  usage: {
    summary: (days) => ipcRenderer.invoke('usage.summary', days),
    hourly:  (hours) => ipcRenderer.invoke('usage.hourly', hours),
    cachePrediction: (model) => ipcRenderer.invoke('usage.cachePrediction', model),
    records: (hours, offset, limit) => ipcRenderer.invoke('usage.records', hours, offset, limit),
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions.list'),
    listArchived: () => ipcRenderer.invoke('sessions.listArchived'),
    load: (id) => ipcRenderer.invoke('sessions.load', id),
    delete: (id) => ipcRenderer.invoke('sessions.delete', id),
    rename: (id, title) => ipcRenderer.invoke('sessions.rename', id, title),
    pin: (id, pinned) => ipcRenderer.invoke('sessions.pin', id, pinned),
    archive: (id, archived) => ipcRenderer.invoke('sessions.archive', id, archived),
    reveal: (id) => ipcRenderer.invoke('sessions.reveal', id),
  },
  window: {
    minimize: () => ipcRenderer.invoke('window.minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window.toggleMaximize'),
    close: () => ipcRenderer.invoke('window.close'),
  },
  clipboard: {
    write: (text) => ipcRenderer.invoke('clipboard.write', text),
  },
  automation: {
    list: () => ipcRenderer.invoke('automation.list'),
    get: (taskId) => ipcRenderer.invoke('automation.get', taskId),
    create: (input) => ipcRenderer.invoke('automation.create', input),
    update: (taskId, updates) => ipcRenderer.invoke('automation.update', taskId, updates),
    delete: (taskId) => ipcRenderer.invoke('automation.delete', taskId),
    start: (taskId) => ipcRenderer.invoke('automation.start', taskId),
    stop: (taskId) => ipcRenderer.invoke('automation.stop', taskId),
    run: (taskId) => ipcRenderer.invoke('automation.run', taskId),
    history: (taskId, limit) => ipcRenderer.invoke('automation.history', taskId, limit),
    active: () => ipcRenderer.invoke('automation.active'),
    onChanged: (handler) => {
      const listener = () => handler();
      ipcRenderer.on('automation.changed', listener);
      return () => ipcRenderer.removeListener('automation.changed', listener);
    },
  },
  agent: {
    start: (resumeSessionId) => ipcRenderer.invoke('agent.start', resumeSessionId),
    prompt: (text, files, toolScope) => ipcRenderer.invoke('agent.prompt', text, files, toolScope),
    taskBoardAction: (action, taskId) => ipcRenderer.invoke('agent.taskBoardAction', action, taskId),
    setEffort: (reasoningEffort) => ipcRenderer.invoke('agent.setEffort', reasoningEffort),
    setToolScope: (toolScope) => ipcRenderer.invoke('agent.setToolScope', toolScope),
    cancel: () => ipcRenderer.invoke('agent.cancel'),
    restart: () => ipcRenderer.invoke('agent.restart'),
    approve: (requestId, decision) => ipcRenderer.invoke('agent.approve', requestId, decision),
    undo: (checkpointIds) => ipcRenderer.invoke('agent.undo', checkpointIds),
    onEvent: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('agent.event', listener);
      return () => ipcRenderer.removeListener('agent.event', listener);
    },
  },
  ai: {
    complete: (request) => ipcRenderer.invoke('ai.complete', request),
    edit: (selection, instruction, context) => ipcRenderer.invoke('ai.edit', selection, instruction, context),
  },
  terminal: {
    create: (options) => ipcRenderer.invoke('terminal.create', options),
    write: (id, data) => ipcRenderer.invoke('terminal.write', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('terminal.resize', id, cols, rows),
    kill: (id) => ipcRenderer.invoke('terminal.kill', id),
    onEvent: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('terminal.event', listener);
      return () => ipcRenderer.removeListener('terminal.event', listener);
    },
  },
  preview: {
    describe:        (relativePath)                     => ipcRenderer.invoke('preview.describe',        relativePath),
    inspectProject:  (relativePath)                     => ipcRenderer.invoke('preview.inspectProject',  relativePath),
    startStatic:     (relativePath, token)              => ipcRenderer.invoke('preview.startStatic',     relativePath, token),
    startDevServer:  (relativePath, script, pm, token)  => ipcRenderer.invoke('preview.startDevServer',  relativePath, script, pm, token),
    stopPreview:     (token)                            => ipcRenderer.invoke('preview.stopPreview',     token),
    installDeps:     (relativePath, pkgManager)         => ipcRenderer.invoke('preview.installDeps',     relativePath, pkgManager),
    setBounds:       (bounds)                           => ipcRenderer.invoke('preview.setBounds',       bounds),
    show:            (url, allowedPort)                 => ipcRenderer.invoke('preview.show',            url, allowedPort),
    hide:            ()                                 => ipcRenderer.invoke('preview.hide'),
    back:            ()                                 => ipcRenderer.invoke('preview.back'),
    forward:         ()                                 => ipcRenderer.invoke('preview.forward'),
    reload:          ()                                 => ipcRenderer.invoke('preview.reload'),
    canNavigate:     ()                                 => ipcRenderer.invoke('preview.canNavigate'),
    openExternal:    (url)                              => ipcRenderer.invoke('preview.openExternal',    url),
    readDocx:        (relativePath, token)              => ipcRenderer.invoke('preview.readDocx',        relativePath, token),
    onState: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('preview.state', listener);
      return () => ipcRenderer.removeListener('preview.state', listener);
    },
    onLog: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('preview.log', listener);
      return () => ipcRenderer.removeListener('preview.log', listener);
    },
  },
  computer: {
    detectBrowserExtension: () => ipcRenderer.invoke('computer.detectBrowserExtension'),
  },
  nav: {
    symbols:          (pattern)            => ipcRenderer.invoke('nav.symbols',          pattern),
    fileSearch:       (pattern)            => ipcRenderer.invoke('nav.fileSearch',        pattern),
    readSymbolContext:(filePath, line)      => ipcRenderer.invoke('nav.readSymbolContext', filePath, line),
  },
  fim: {
    complete:   (req) => ipcRenderer.invoke('fim.complete',  req),
    configure:  (opts) => ipcRenderer.invoke('fim.configure', opts),
  },
  language: {
    hover:       (req) => ipcRenderer.invoke('language.hover', req),
    definition:  (req) => ipcRenderer.invoke('language.definition', req),
    references:  (req) => ipcRenderer.invoke('language.references', req),
    completions: (req) => ipcRenderer.invoke('language.completions', req),
  },
  git: {
    status:       ()                           => ipcRenderer.invoke('git.status'),
    branches:     ()                           => ipcRenderer.invoke('git.branches'),
    log:          (n)                          => ipcRenderer.invoke('git.log', n),
    diff:         (staged)                     => ipcRenderer.invoke('git.diff', staged),
    fileChangeRanges: (filePath)               => ipcRenderer.invoke('git.fileChangeRanges', filePath),
    stage:        (paths)                      => ipcRenderer.invoke('git.stage', paths),
    unstage:      (paths)                      => ipcRenderer.invoke('git.unstage', paths),
    discard:      (paths)                      => ipcRenderer.invoke('git.discard', paths),
    commit:       (message)                    => ipcRenderer.invoke('git.commit', message),
    push:         (remote, branch, force)      => ipcRenderer.invoke('git.push', remote, branch, force),
    pull:         (remote, branch)             => ipcRenderer.invoke('git.pull', remote, branch),
    checkout:     (branch)                     => ipcRenderer.invoke('git.checkout', branch),
    createBranch: (name)                       => ipcRenderer.invoke('git.createBranch', name),
    deleteBranch: (name, force)                => ipcRenderer.invoke('git.deleteBranch', name, force),
    createPr:     (opts)                       => ipcRenderer.invoke('git.createPr', opts),
  },
});

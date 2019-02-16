/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        ZettlrIPC class
 * CVM-Role:        Controller
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This class is basically the postmaster of the app. There are
 *                  three channels that are used for communication:
 *                  - message: The default channel for most of the stuff (async)
 *                  - config: Retrieve configuration values (sync)
 *                  - typo: Retrieve dictionary functions (sync)
 *
 * END HEADER
 */

const { trans } = require('../common/lang/i18n.js')
const ipc = require('electron').ipcMain
const { BrowserWindow } = require('electron') // Needed for close and maximise commands

/**
 * This class acts as the interface between the main process and the renderer.
 * It receives messages from the renderer and dispatches them to their appropriate
 * addressees, as well as send commands after a small sanity check (such that
 * the content is never empty)
 */
class ZettlrIPC {
  /**
    * Create the ipc
    * @param {Zettlr} zettlrObj The application main object
    */
  constructor (zettlrObj) {
    this._app = zettlrObj

    // Listen for synchronous messages from the renderer process to access
    // config options.
    ipc.on('config', (event, key) => {
      // We have received a config event -> simply return back the respective
      // key.
      event.returnValue = global.config.get(key)
    })

    // Listen for synchronous messages from the renderer process for typos.
    ipc.on('typo', (event, message) => {
      if (message.type === 'check') {
        event.returnValue = (this._app.dict) ? this._app.dict.check(message.term) : 'not-ready'
      } else if (message.type === 'suggest') {
        event.returnValue = (this._app.dict) ? this._app.dict.suggest(message.term) : []
      }
    })

    // Citeproc calls (either single citation or a whole cluster)
    ipc.on('getCitation', (event, idList) => { event.returnValue = global.citeproc.getCitation(idList) })
    ipc.on('updateItems', (event, idList) => { event.returnValue = global.citeproc.updateItems(idList) })

    // Beginn listening to messages
    ipc.on('message', (event, arg) => {
      // We always need a command
      if (!arg.hasOwnProperty('command')) {
        console.error(trans('system.no_command'), arg)
        return
      }

      if (arg.command === 'file-drag-start') {
        event.sender.startDrag({
          'file': this._app.findFile({ hash: parseInt(arg.content.hash) }).path,
          'icon': require('path').join(__dirname, '/assets/dragicon.png')
        })
        return // Don't dispatch further
      }

      // Next possibility: An asynchronous callback from the renderer.
      if (arg.hasOwnProperty('cypher') && arg.cypher !== '') {
        // In this case we have to run whatever is wanted and immediately return
        // (Don't let yourselves be fooled by how I named this argument. This is
        // only to confuse myself in some months when I will stumble back upon
        // this piece of code and wonder why I have to send/return the thing
        // twice.)
        arg.returnValue = this.runCall(arg.command, arg.content)
        event.sender.send('message', arg)
        return // Also, don't dispatch further
      }

      // Last possibility: A quicklook window has requested a file. In this case
      // we mustn't obliterate the "event" because this way we don't need to
      // search for the window.
      if (arg.command === 'ql-get-file') {
        event.sender.send('file', this._app.findFile({ 'hash': arg.content }).withContent())
        return
      }

      // In all other occasions omit the event.
      this.dispatch(arg)
    })

    // Enable some globals for sending to the renderer
    global.ipc = {
      /**
       * Sends a message to the renderer and displays it as a notification.
       * @param  {String} msg The message to be sent.
       * @return {void}       Does not return.
       */
      notify: (msg) => { this.send('notify', msg) },
      /**
       * Sends an error to the renderer process that should be displayed using
       * a dedicated dialog window (is used, e.g., during export when Pandoc
       * throws potentially a lot of useful information for fixing problems in
       * the source files).
       * @param  {Object} msg        The error object
       * @return {void}            Does not return.
       */
      notifyError: (msg) => { this.send('notify-error', msg) },
      /**
       * Replaces the given file in the renderer. Can be used by any file to
       * update itself in the renderer without having to issue a full path
       * update.
       * @param  {ZettlrFile} file A file which should be updated
       * @return {void}       Does not return.
       */
      updateFile: (file) => { this.send('file-replace', { 'hash': file.hash, 'file': file.getMetadata() }) }
    }
  }

  /**
    * This function gets called every time the renderer sends a message.
    * @param  {Object} arg   The message's body
    * @return {void}       Does not return anything.
    */
  dispatch (arg) {
    // handleEvent expects arg to contain at least 'command' and 'content'
    // properties. That 'command' exists is checked by the message handler
    if (!arg.hasOwnProperty('content')) arg.content = {}
    this.handleEvent(arg.command, arg.content)
  }

  /**
    * This sends a message to the current window's renderer process.
    * @param  {String} command      The command to be sent
    * @param  {Object} [content={}] Can be either simply a string or a whole object
    * @return {ZettlrIPC}              This for chainability.
    */
  send (command, content = {}) {
    if (!this._app.window.getWindow()) {
      return this // Fail gracefully
    }
    let sender = this._app.window.getWindow().webContents
    sender.send('message', {
      'command': command,
      'content': content
    })

    return this
  }

  /**
    * This function switches through the received command and issues function
    * calls to the zettlr object according to the events.
    * @param {String} cmd The command to be handled
    * @param  {Object} cnt   Contains the message body.
    * @return {void}       Does not return anything.
    */
  handleEvent (cmd, cnt) {
    // We received a new event and need to handle it.

    // This class can handle some events by itself, because they don't involve
    // a lot of code and it saves space doing it here. Therefore we need some vars.

    try {
      let res = this._app.runCommand(cmd, cnt)
      return res // In case the command has run there's no need to handle it.
    } catch (e) {
      // Simple fall through
    }

    switch (cmd) {
      case 'app-quit':
        // This command is sent by the renderer once the user requested to quit
        // the app. This way it is ensured that the "save before quit?"-message
        // only shows in rare cases where the file cannot be saved.
        require('electron').app.quit()
        break

      // Window controls for the Quicklook windows must use IPC calls
      case 'win-maximise':
        if (BrowserWindow.getFocusedWindow()) {
          // Implements maximise-toggling for windows
          if (BrowserWindow.getFocusedWindow().isMaximized()) {
            BrowserWindow.getFocusedWindow().unmaximize()
          } else {
            BrowserWindow.getFocusedWindow().maximize()
          }
        }
        break

      case 'win-minimise':
        if (BrowserWindow.getFocusedWindow()) BrowserWindow.getFocusedWindow().minimize()
        break

      case 'win-close':
        if (BrowserWindow.getFocusedWindow()) BrowserWindow.getFocusedWindow().close()
        break

      // Also the application menu must be shown on request
      case 'win-menu':
        this._app.getWindow().popupMenu(cnt.x, cnt.y)
        break

      case 'get-paths':
        // The child process requested the current paths and files
        this.send('paths-update', this._app.getPathDummies())
        // Also set the current file and dir correctly immediately
        this.send('file-set-current', (this._app.getCurrentFile()) ? this._app.getCurrentFile().hash : null)
        this.send('dir-set-current', (this._app.getCurrentDir()) ? this._app.getCurrentDir().hash : null)
        if (this._app.getCurrentFile()) this.send('file-open', this._app.getCurrentFile().withContent())
        break

      case 'file-get-quicklook':
        this.send('file-quicklook', this._app.findFile({ 'hash': cnt }).withContent())
        break

      case 'file-get':
        // The client requested a different file.
        this._app.sendFile(cnt)
        break

      case 'dir-select':
        // The client requested another directory
        this._app.selectDir(cnt)
        break

      case 'file-modified':
        // Just set the modification flags.
        this._app.setModified()
        break

      // Set or update a target
      case 'set-target':
        global.targets.set(cnt)
        break

      case 'dir-open':
        // Client requested a totally different folder.
        this._app.open()
        break

      case 'close-root':
        this._app.close(cnt)
        break

      case 'file-search':
        // arg.content contains a hash of the file to be searched
        // and the prepared terms.
        let ret = this._app.findFile({ 'hash': cnt.hash }).search(cnt.terms)
        this.send('file-search-result', {
          'hash': cnt.hash,
          'result': ret
        })
        break

      // Force-open is basically a search and immediate return.
      case 'force-open':
        let open = this._app.findExact(cnt) // Find an exact match
        if (open != null) {
          this._app.sendFile(open.hash)
        }
        break

      // Change theme in config
      case 'toggle-theme':
        global.config.set('darkTheme', !global.config.get('darkTheme'))
        this.send('config-update')
        break

      // Change snippet setting in config
      case 'toggle-snippets':
        global.config.set('snippets', !global.config.get('snippets'))
        this.send('config-update')
        break

      case 'get-preferences':
      // Duplicate the object
        let toSend = Object.assign({}, this._app.getConfig().getConfig())
        // Add available translations and dictionaries
        toSend.supportedLangs = this._app.getConfig().getSupportedLangs()
        toSend.availableDicts = this._app.getConfig().getDictionaries()
        this.send('preferences', toSend)
        break

      case 'get-pdf-preferences':
        // Get the same whole config object. ZettlrDialog will filter out
        // the PDF preferences. Why do we need the whole? Because the project
        // settings are a superset of PDF, so to save space, we'll re-use
        // their code, but to unify it we need these settings to access
        // obj.pdf instead of obj.
        this.send('pdf-preferences', this._app.getConfig().getConfig())
        break

      case 'get-tags-preferences':
        this.send('tags-preferences', this._app.getTags().get())
        break

      // Got a new config object
      case 'update-config':
        this._app.getConfig().bulkSet(cnt)
        this.send('config-update')
        // Reload the dictionaries based on the user's selection
        // The dict property will not be preset if there were not dictionaries
        // loaded.
        if (this._app.dict) this._app.dict.reload()
        break

      case 'update-tags':
        this._app.getTags().update(cnt)
        this.send('set-tags', cnt) // Send back to renderer so preview knows about this
        break

      // Send the database of tags to display explicitly in the preview pane to
      // the renderer.
      case 'get-tags':
        this.send('set-tags', this._app.getTags().get())
        break

      // Send the global tag database to the renderer process.
      case 'get-tags-database':
        this.send('tags-database', global.tags.get())
        break

      // Handle dropped files/folders
      case 'handle-drop':
        this._app.handleAddRoots(cnt)
        break

      // Statistics
      case 'request-stats-data':
        this.send('stats-data', this._app.getStats().getStats())
        break

      // Return a list of all available IDs in the currently loaded database
      case 'citeproc-get-ids':
        this.send('citeproc-ids', (global.citeproc) ? global.citeproc.getIDs() : [])
        break

      // The renderer requested an updated bibliography
      case 'citeproc-make-bibliography':
        this.send('citeproc-bibliography', global.citeproc.makeBibliography())
        break

      default:
        console.log(trans('system.unknown_command', cmd))
        break
    }
  }

  /**
   * Literally the same as dispatch(), only with returns
   * @param  {string} cmd The Command
   * @param  {Object} arg The payload
   * @return {Mixed}     Whatever is registered in runCall to return for a given cmd.
   */
  runCall (cmd, arg) {
    switch (cmd) {
      // Window controls actions can be send either as callback IPC calls or as
      // normals (which is why they are present both in runCall and handleEvent)
      case 'win-maximise':
        if (BrowserWindow.getFocusedWindow()) {
          // Implements maximise-toggling for windows
          if (BrowserWindow.getFocusedWindow().isMaximized()) {
            BrowserWindow.getFocusedWindow().unmaximize()
          } else {
            BrowserWindow.getFocusedWindow().maximize()
          }
        }
        break

      case 'win-minimise':
        if (BrowserWindow.getFocusedWindow()) BrowserWindow.getFocusedWindow().minimize()
        break

      case 'win-close':
        if (BrowserWindow.getFocusedWindow()) BrowserWindow.getFocusedWindow().close()
        break

      // We should show the askFile dialog to the user and return its result.
      case 'request-files':
        // The client only can choose what and how much it wants to get
        return this._app.getWindow().askFile(arg.filters, arg.multiSel)

      // A quicklook window wants to pop-out of the main window
      case 'make-standalone':
        this._app.openQL(arg)
        return true

      // Send the global tag database to the renderer process.
      case 'get-tags-database':
        return global.tags.get()

      // Returns the custom CSS's file contents
      case 'get-custom-css':
        return this._app.getConfig().getCustomCSS()

      // Returns the custm CSS's file name
      case 'get-custom-css-path':
        return this._app.getConfig().getCustomCSSPath()

      // Updates the file contents
      case 'set-custom-css':
        return this._app.getConfig().setCustomCSS(arg)

      default:
        console.log(trans('system.unknown_command', cmd))
        return null
    }
  }
}

module.exports = ZettlrIPC

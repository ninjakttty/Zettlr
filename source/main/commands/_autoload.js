/**
 * This is the autoloader function that retrieves and returns all commands
 * placed in this folder.
 */

const fs = require('fs')
const path = require('path')

// Promisify the readdir function
const readDir = require('util').promisify(fs.readdir)

module.exports = async function (app) {
  // First list the directory
  let dirs = await readDir(__dirname)

  // Sanitise the directory -> throw out everything that's not javascript
  dirs = dirs.filter(elem => /\.jsx?$/.test(elem))

  let cmd = []

  for (let file of dirs) {
    // Don't include the builtins
    if (file === '_autoload.js' || file === 'zettlr-command.js') continue

    let Command = require(path.join(__dirname, file))

    // Instantiate the command
    cmd.push(new Command(app))
  }

  // After all commands have been set up return the array.
  return cmd
}

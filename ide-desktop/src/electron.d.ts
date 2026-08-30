// Electron-specific extensions to standard web APIs.
interface File {
  /**
   * The real path to the file on the user's filesystem.
   * Available in Electron's File objects from drag-and-drop operations.
   */
  path?: string;
}

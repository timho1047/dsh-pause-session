/** CSS Modules compile to hashed class maps; the class names are build-generated. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

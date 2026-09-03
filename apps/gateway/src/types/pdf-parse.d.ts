declare module "pdf-parse" {
  const pdf: (buffer: Buffer) => Promise<{ text: string }>;
  export default pdf;
}

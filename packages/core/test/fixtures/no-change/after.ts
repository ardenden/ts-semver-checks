export function greet(name: string): string {
  return `hello ${name}`;
}
export interface Config {
  timeout: number;
  retries?: number;
}

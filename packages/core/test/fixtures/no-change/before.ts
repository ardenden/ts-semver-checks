export function greet(name: string): string {
  return `hi ${name}`;
}
export interface Config {
  timeout: number;
  retries?: number;
}

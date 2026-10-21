declare var SmartScmLineOrder: {
  key(line: any): string;
  ordered<T extends Record<string, any>>(lines: T[], order?: string[]): T[];
  validate(order: unknown, lines: any[]): string[];
  payload<T>(items: T[], keys: string[], order?: string[]): T[];
  sequence(row: any): number | null;
};

import type { Command } from "commander";
export interface VibePlugin {
    name: string;
    version: string;
    description?: string;
    onCliSetup?: (program: Command) => void | Promise<void>;
}
export declare const vibePlugin: VibePlugin;
export default vibePlugin;
//# sourceMappingURL=index.d.ts.map
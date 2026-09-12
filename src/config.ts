export const SEPOLIA_CHAIN_ID = 11155111;

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return v;
}

export const config = {
  rpcUrl: () => required('SEPOLIA_RPC_URL'),
  dbPath: process.env.DB_PATH ?? 'data/trace.db',
  port: Number(process.env.PORT ?? 3000),
  confirmations: Number(process.env.CONFIRMATIONS ?? 6),
};

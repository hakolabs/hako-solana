const anchor = require("@coral-xyz/anchor");
const fs = require("fs");
const path = require("path");
const { SystemProgram } = require("@solana/web3.js");

function loadKeypair(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const secret = Uint8Array.from(JSON.parse(raw));
  return anchor.web3.Keypair.fromSecretKey(secret);
}

function resolveRpcUrl() {
  const cluster = (process.env.CLUSTER || "mainnet").toLowerCase();
  if (cluster === "mainnet") {
    return anchor.web3.clusterApiUrl("mainnet-beta");
  }
  return anchor.web3.clusterApiUrl(cluster);
}

async function main() {
  const mintArg = process.argv[2];
  if (!mintArg) {
    throw new Error("Usage: node scripts/add-allowed-token.js <MINT_ADDRESS>");
  }

  const walletPath =
    process.env.ANCHOR_WALLET || path.join(process.env.HOME || "", ".config/solana/id.json");

  const keypair = loadKeypair(walletPath);
  const wallet = new anchor.Wallet(keypair);
  const connection = new anchor.web3.Connection(resolveRpcUrl(), "confirmed");
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idlPath = path.join("target", "idl", "hako_remote_vault.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const programIdValue = process.env.PROGRAM_ID || idl.address;
  if (!programIdValue) {
    throw new Error("PROGRAM_ID is required when IDL address is missing");
  }
  idl.address = programIdValue;

  const program = new anchor.Program(idl, provider);
  const mint = new anchor.web3.PublicKey(mintArg);

  const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  const [allowedTokenPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("allowed_token"), mint.toBuffer()],
    program.programId
  );

  const vaultAta = anchor.utils.token.associatedAddress({
    mint,
    owner: configPda,
  });

  const tx = await program.methods
    .addAllowedToken()
    .accounts({
      config: configPda,
      owner: wallet.publicKey,
      mint,
      allowedToken: allowedTokenPda,
      vaultTokenAccount: vaultAta,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();

  console.log("addAllowedToken tx:", tx);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

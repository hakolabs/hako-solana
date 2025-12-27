import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { HakoRemoteVault } from "../target/types/hako_remote_vault";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";

describe("hako-remote-vault", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.hakoRemoteVault as Program<HakoRemoteVault>;

  const TOKEN_PROGRAM_ID = anchor.utils.token.TOKEN_PROGRAM_ID;

  const MINT_SIZE = 82;
  const TOKEN_ACCOUNT_SIZE = 165;

  function u64ToLe(amount: bigint): Buffer {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(amount);
    return buf;
  }

  function createInitializeMintInstruction(args: {
    mint: PublicKey;
    decimals: number;
    mintAuthority: PublicKey;
    freezeAuthority: PublicKey | null;
  }): TransactionInstruction {
    const data = Buffer.alloc(1 + 1 + 32 + 1 + 32);
    data.writeUInt8(0, 0); // InitializeMint
    data.writeUInt8(args.decimals, 1);
    args.mintAuthority.toBuffer().copy(data, 2);
    if (args.freezeAuthority) {
      data.writeUInt8(1, 34);
      args.freezeAuthority.toBuffer().copy(data, 35);
    } else {
      data.writeUInt8(0, 34);
      Buffer.alloc(32).copy(data, 35);
    }

    return new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: args.mint, isSigner: false, isWritable: true },
        { pubkey: anchor.web3.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data,
    });
  }

  function createInitializeAccountInstruction(args: {
    account: PublicKey;
    mint: PublicKey;
    owner: PublicKey;
  }): TransactionInstruction {
    return new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: args.account, isSigner: false, isWritable: true },
        { pubkey: args.mint, isSigner: false, isWritable: false },
        { pubkey: args.owner, isSigner: false, isWritable: false },
        { pubkey: anchor.web3.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]), // InitializeAccount
    });
  }

  function createMintToInstruction(args: {
    mint: PublicKey;
    destination: PublicKey;
    authority: PublicKey;
    amount: bigint;
  }): TransactionInstruction {
    return new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: args.mint, isSigner: false, isWritable: true },
        { pubkey: args.destination, isSigner: false, isWritable: true },
        { pubkey: args.authority, isSigner: true, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([7]), u64ToLe(args.amount)]), // MintTo
    });
  }

  async function getTokenBalance(connection: anchor.web3.Connection, tokenAccount: PublicKey): Promise<bigint> {
    const bal = await connection.getTokenAccountBalance(tokenAccount);
    return BigInt(bal.value.amount);
  }

  it("deposit and bridge_to_near_intent (happy path)", async () => {
    const provider = anchor.getProvider() as anchor.AnchorProvider;
    const connection = provider.connection;
    const payer = provider.wallet.publicKey;

    const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], program.programId);

    // Create test mint (6 decimals like USDC/USDT)
    const mintKeypair = anchor.web3.Keypair.generate();
    const mintLamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);

    // Create user token account (owned by payer)
    const userTokenKeypair = anchor.web3.Keypair.generate();
    const tokenLamports = await connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE);

    const createMintTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer,
        newAccountPubkey: mintKeypair.publicKey,
        lamports: mintLamports,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMintInstruction({
        mint: mintKeypair.publicKey,
        decimals: 6,
        mintAuthority: payer,
        freezeAuthority: null,
      }),
      SystemProgram.createAccount({
        fromPubkey: payer,
        newAccountPubkey: userTokenKeypair.publicKey,
        lamports: tokenLamports,
        space: TOKEN_ACCOUNT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccountInstruction({
        account: userTokenKeypair.publicKey,
        mint: mintKeypair.publicKey,
        owner: payer,
      }),
      createMintToInstruction({
        mint: mintKeypair.publicKey,
        destination: userTokenKeypair.publicKey,
        authority: payer,
        amount: 1_000_000n, // 1.0 (6 decimals)
      }),
    );

    await provider.sendAndConfirm(createMintTx, [mintKeypair, userTokenKeypair]);

    // Initialize vault
    await program.methods
      .initialize(payer)
      .accounts({ payer, config: configPda, systemProgram: SystemProgram.programId })
      .rpc();

    const [allowedTokenPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("allowed_token"), mintKeypair.publicKey.toBuffer()],
      program.programId,
    );

    const vaultAta = anchor.utils.token.associatedAddress({
      mint: mintKeypair.publicKey,
      owner: configPda,
    });

    await program.methods
      .addAllowedToken()
      .accounts({
        config: configPda,
        owner: payer,
        mint: mintKeypair.publicKey,
        allowedToken: allowedTokenPda,
        vaultTokenAccount: vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const receiver = anchor.web3.Keypair.generate().publicKey;

    await program.methods
      .deposit(new anchor.BN(1_000_000), receiver)
      .accounts({
        config: configPda,
        allowedToken: allowedTokenPda,
        user: payer,
        userTokenAccount: userTokenKeypair.publicKey,
        vaultTokenAccount: vaultAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const cfg = await program.account.vaultConfig.fetch(configPda);
    if (!cfg.nextDepositId.eq(new anchor.BN(1))) {
      throw new Error(`expected next_deposit_id=1, got ${cfg.nextDepositId.toString()}`);
    }

    const vaultBal = await getTokenBalance(connection, vaultAta);
    const userBal = await getTokenBalance(connection, userTokenKeypair.publicKey);
    if (vaultBal !== 1_000_000n || userBal !== 0n) {
      throw new Error(`unexpected balances vault=${vaultBal} user=${userBal}`);
    }

    const destinationWallet = anchor.web3.Keypair.generate().publicKey;
    const destinationAta = anchor.utils.token.associatedAddress({
      mint: mintKeypair.publicKey,
      owner: destinationWallet,
    });

    await program.methods
      .bridgeToNearIntent(new anchor.BN(1_000_000))
      .accounts({
        config: configPda,
        owner: payer,
        allowedToken: allowedTokenPda,
        mint: mintKeypair.publicKey,
        vaultTokenAccount: vaultAta,
        destinationWallet,
        destinationTokenAccount: destinationAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: anchor.utils.token.ASSOCIATED_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const vaultBal2 = await getTokenBalance(connection, vaultAta);
    const destBal = await getTokenBalance(connection, destinationAta);
    if (vaultBal2 !== 0n || destBal !== 1_000_000n) {
      throw new Error(`unexpected balances after bridge vault=${vaultBal2} dest=${destBal}`);
    }
  });
});

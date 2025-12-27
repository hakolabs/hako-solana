# Hako Remote Vault (Solana)

Anchor program that mirrors the `HakoRemoteVault` remote-chain flow on Solana:
- Owner allowlists SPL token mints (stablecoins)
- Users deposit SPL tokens into the vault’s ATA (owned by a PDA)
- Vault emits a deposit event with 18-decimal normalized amount
- Owner can transfer (bridge out) vault balances to a destination SPL token account (e.g. a NEAR Intents deposit token account)

## Build

```bash
cd hako-solana
anchor build
```

## Test (localnet)

```bash
cd hako-solana
anchor test
```

If your Solana keypair isn’t at `~/.config/solana/id.json`, override it:

```bash
anchor test --provider.wallet <PATH_TO_KEYPAIR_JSON>
```

## On-chain accounts

- `VaultConfig` PDA: `seeds = ["config"]`
  - `owner: Pubkey`
  - `next_deposit_id: u64`
- `AllowedToken` PDA: `seeds = ["allowed_token", mint]`
  - `mint: Pubkey`
  - `decimals: u8` (must be `<= 18`)
- Vault token account (per mint): ATA for `(authority = VaultConfig PDA, mint = <mint>)`

## Program instructions

- `initialize(owner)`
- `set_owner(new_owner)` (owner-only)
- `add_allowed_token()` (owner-only; stores `mint.decimals` and creates the vault ATA for this mint)
- `deposit(amount, receiver)` (user; transfers from user token account → vault ATA and emits `DepositInitiated`)
- `bridge_to_near_intent(amount)` (owner-only; transfers from vault ATA → destination wallet ATA and emits `BridgedOut`)

## Notes

- `receiver` in `deposit` is always a **Solana public key** (the beneficiary on the Hako side).
- NEAR Intents deposit “address” on Solana is a **wallet address**; SPL tokens are sent to its **ATA** for that mint.


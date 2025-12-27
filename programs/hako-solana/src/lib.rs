use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address,
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

declare_id!("HK6CGFmiY5LnLDR4u8prywRvNBMdyGuWXrcYKeNwFzwR");

const CONFIG_SEED: &[u8] = b"config";
const ALLOWED_TOKEN_SEED: &[u8] = b"allowed_token";
const NORMALIZED_DECIMALS: u8 = 18;

#[program]
pub mod hako_remote_vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, owner: Pubkey) -> Result<()> {
        require!(owner != Pubkey::default(), HakoError::InvalidOwner);
        ctx.accounts.config.owner = owner;
        ctx.accounts.config.next_deposit_id = 0;
        Ok(())
    }

    pub fn set_owner(ctx: Context<SetOwner>, new_owner: Pubkey) -> Result<()> {
        require!(new_owner != Pubkey::default(), HakoError::InvalidOwner);
        ctx.accounts.config.owner = new_owner;
        emit!(OwnerUpdated {
            old_owner: ctx.accounts.owner.key(),
            new_owner,
        });
        Ok(())
    }

    pub fn add_allowed_token(ctx: Context<AddAllowedToken>) -> Result<()> {
        ctx.accounts.allowed_token.mint = ctx.accounts.mint.key();
        ctx.accounts.allowed_token.decimals = ctx.accounts.mint.decimals;

        require!(
            ctx.accounts.allowed_token.decimals <= NORMALIZED_DECIMALS,
            HakoError::DecimalsTooHigh
        );

        emit!(AllowedTokenAdded {
            mint: ctx.accounts.allowed_token.mint,
            decimals: ctx.accounts.allowed_token.decimals,
        });
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64, receiver: Pubkey) -> Result<()> {
        require!(amount > 0, HakoError::InvalidAmount);
        require!(receiver != Pubkey::default(), HakoError::InvalidReceiver);

        require!(
            ctx.accounts.user_token_account.mint == ctx.accounts.allowed_token.mint,
            HakoError::InvalidMint
        );
        require!(
            ctx.accounts.vault_token_account.mint == ctx.accounts.allowed_token.mint,
            HakoError::InvalidMint
        );

        let expected_vault_ata = get_associated_token_address(&ctx.accounts.config.key(), &ctx.accounts.allowed_token.mint);
        require!(
            ctx.accounts.vault_token_account.key() == expected_vault_ata,
            HakoError::InvalidVaultTokenAccount
        );
        require!(
            ctx.accounts.vault_token_account.owner == ctx.accounts.config.key(),
            HakoError::InvalidVaultTokenAccount
        );

        let normalized = normalize_amount(amount, ctx.accounts.allowed_token.decimals)?;

        ctx.accounts.config.next_deposit_id = ctx
            .accounts
            .config
            .next_deposit_id
            .checked_add(1)
            .ok_or(HakoError::MathOverflow)?;

        let deposit_id = ctx.accounts.config.next_deposit_id;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.vault_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        emit!(DepositInitiated {
            deposit_id,
            user: ctx.accounts.user.key(),
            mint: ctx.accounts.allowed_token.mint,
            amount,
            amount_normalized: normalized,
            receiver,
        });

        Ok(())
    }

    pub fn bridge_to_near_intent(ctx: Context<BridgeToNearIntent>, amount: u64) -> Result<()> {
        require!(amount > 0, HakoError::InvalidAmount);
        require!(
            ctx.accounts.vault_token_account.mint == ctx.accounts.allowed_token.mint,
            HakoError::InvalidMint
        );
        require!(
            ctx.accounts.destination_token_account.mint == ctx.accounts.allowed_token.mint,
            HakoError::InvalidMint
        );

        let expected_vault_ata = get_associated_token_address(&ctx.accounts.config.key(), &ctx.accounts.allowed_token.mint);
        require!(
            ctx.accounts.vault_token_account.key() == expected_vault_ata,
            HakoError::InvalidVaultTokenAccount
        );
        require!(
            ctx.accounts.vault_token_account.owner == ctx.accounts.config.key(),
            HakoError::InvalidVaultTokenAccount
        );

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    to: ctx.accounts.destination_token_account.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[&[CONFIG_SEED, &[ctx.bumps.config]]],
            ),
            amount,
        )?;

        emit!(BridgedOut {
            mint: ctx.accounts.allowed_token.mint,
            destination_wallet: ctx.accounts.destination_wallet.key(),
            destination_token_account: ctx.accounts.destination_token_account.key(),
            amount,
        });

        Ok(())
    }
}

fn normalize_amount(amount: u64, decimals: u8) -> Result<u128> {
    require!(decimals <= NORMALIZED_DECIMALS, HakoError::DecimalsTooHigh);
    let factor = 10u128
        .checked_pow((NORMALIZED_DECIMALS - decimals) as u32)
        .ok_or(HakoError::MathOverflow)?;
    let normalized = (amount as u128)
        .checked_mul(factor)
        .ok_or(HakoError::MathOverflow)?;
    Ok(normalized)
}

#[account]
#[derive(InitSpace)]
pub struct VaultConfig {
    pub owner: Pubkey,
    pub next_deposit_id: u64,
}

#[account]
#[derive(InitSpace)]
pub struct AllowedToken {
    pub mint: Pubkey,
    pub decimals: u8,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + VaultConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, VaultConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetOwner<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = owner)]
    pub config: Account<'info, VaultConfig>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct AddAllowedToken<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = owner)]
    pub config: Account<'info, VaultConfig>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = owner,
        space = 8 + AllowedToken::INIT_SPACE,
        seeds = [ALLOWED_TOKEN_SEED, mint.key().as_ref()],
        bump
    )]
    pub allowed_token: Account<'info, AllowedToken>,
    #[account(
        init,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = config
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, VaultConfig>,
    #[account(seeds = [ALLOWED_TOKEN_SEED, allowed_token.mint.as_ref()], bump)]
    pub allowed_token: Account<'info, AllowedToken>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct BridgeToNearIntent<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump, has_one = owner)]
    pub config: Account<'info, VaultConfig>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [ALLOWED_TOKEN_SEED, allowed_token.mint.as_ref()], bump)]
    pub allowed_token: Account<'info, AllowedToken>,
    #[account(address = allowed_token.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub vault_token_account: Account<'info, TokenAccount>,
    /// CHECK: destination wallet can be any Pubkey (may not exist yet).
    pub destination_wallet: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = mint,
        associated_token::authority = destination_wallet
    )]
    pub destination_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct AllowedTokenAdded {
    pub mint: Pubkey,
    pub decimals: u8,
}

#[event]
pub struct OwnerUpdated {
    pub old_owner: Pubkey,
    pub new_owner: Pubkey,
}

#[event]
pub struct DepositInitiated {
    pub deposit_id: u64,
    pub user: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub amount_normalized: u128,
    pub receiver: Pubkey,
}

#[event]
pub struct BridgedOut {
    pub mint: Pubkey,
    pub destination_wallet: Pubkey,
    pub destination_token_account: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum HakoError {
    #[msg("Invalid owner")]
    InvalidOwner,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Invalid receiver")]
    InvalidReceiver,
    #[msg("Token decimals > 18")]
    DecimalsTooHigh,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Invalid mint")]
    InvalidMint,
    #[msg("Invalid vault token account")]
    InvalidVaultTokenAccount,
}

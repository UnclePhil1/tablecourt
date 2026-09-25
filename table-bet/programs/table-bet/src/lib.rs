/*! Table – the escrow behind a staked 1v1.

   Two players put up the same stake. The pot is held by this program until both of them say who won,
   and only a result they agree on pays anybody. Disagree, or fail to answer before the deadline, and
   each player takes their own stake back. The platform's cut is taken on a payout and never on a
   refund.

   Why both players and not the winner: the match is played in the two browsers and the host runs the
   physics, so the host alone could claim any result it liked. Nothing on chain can prove a rally ever
   happened. What it can do is refuse to pay unless the player who lost agrees. A cheat therefore
   cannot take anybody's stake — the furthest it reaches is a refund.

   Money only ever leaves the vault in three ways: to the winner and the fee wallet on `settle`, back
   to the two players on `refund`, or back to the host on `cancel` before anyone joined. The fee wallet
   is a constant in this file rather than a parameter, so no caller can point the fee somewhere else. */
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer};

declare_id!("9FMrUJ9Ahmxqagixp89t29rs6HoP5KckZLtsgVrnnrAU");

/// Where the platform's cut goes. A constant, not an argument: a caller cannot redirect it, and a
/// reader can see in one line who gets paid.
#[constant]
pub const FEE_WALLET: Pubkey = pubkey!("ByBitp3pCWDhT7MvvrjiFhuczRRbxapS14tGkYpDGLMK");

/// 1% of each player's stake, so 2% of the pot. Both stake 10 and the winner receives 19.8.
pub const FEE_BPS: u16 = 100;
/// A ceiling the code cannot be talked past, in case FEE_BPS is ever edited carelessly.
pub const MAX_FEE_BPS: u16 = 500;

/// A match code as it appears in the invite link, upper-case and padded with zeros.
pub const CODE_LEN: usize = 10;
/// How long a match may run before either player can walk away with their own stake.
pub const MIN_PLAY_SECS: i64 = 5 * 60;
pub const MAX_PLAY_SECS: i64 = 7 * 24 * 60 * 60;

pub const MATCH_SEED: &[u8] = b"match";

/// What each player gets when the two of them agree. Split out so the arithmetic can be read on its
/// own and tested on its own; it is the only place the fee is worked out.
pub fn split(stake: u64, fee_bps: u16) -> Result<(u64, u64)> {
    require!(fee_bps <= MAX_FEE_BPS, BetError::FeeTooHigh);
    // Rounds down, so a stake too small to carry a fee simply carries none.
    let fee_each = (stake as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(BetError::MathOverflow)?
        / 10_000u128;
    let fee = fee_each.checked_mul(2).ok_or(BetError::MathOverflow)?;
    let pot = (stake as u128).checked_mul(2).ok_or(BetError::MathOverflow)?;
    let to_winner = pot.checked_sub(fee).ok_or(BetError::MathOverflow)?;
    Ok((
        u64::try_from(to_winner).map_err(|_| BetError::MathOverflow)?,
        u64::try_from(fee).map_err(|_| BetError::MathOverflow)?,
    ))
}

#[program]
pub mod table_bet {
    use super::*;

    /// The host opens the escrow and pays its stake in. The guest is named here rather than left open,
    /// so a stranger cannot take the seat the invited player was going to use and strand the pot until
    /// the deadline.
    pub fn open(ctx: Context<Open>, code: [u8; CODE_LEN], guest: Pubkey, stake: u64, play_secs: i64) -> Result<()> {
        require!(stake > 0, BetError::StakeTooSmall);
        require!(guest != Pubkey::default(), BetError::GuestMissing);
        require_keys_neq!(guest, ctx.accounts.host.key(), BetError::PlayingYourself);
        require!(
            (MIN_PLAY_SECS..=MAX_PLAY_SECS).contains(&play_secs),
            BetError::BadDeadline
        );
        // Checked now so a match can never be opened that settle would later refuse to pay.
        let _ = split(stake, FEE_BPS)?;

        let m = &mut ctx.accounts.game;
        m.code = code;
        m.mint = ctx.accounts.mint.key();
        m.host = ctx.accounts.host.key();
        m.guest = guest;
        m.stake = stake;
        m.host_claim = None;
        m.guest_claim = None;
        m.state = MatchState::Open;
        // Recorded per match, so upgrading the program cannot change the terms of a match already
        // under way. Every payout reads this, never the constant.
        m.fee_bps = FEE_BPS;
        m.deadline = Clock::get()?
            .unix_timestamp
            .checked_add(play_secs)
            .ok_or(BetError::MathOverflow)?;
        m.bump = ctx.bumps.game;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.host_tokens.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.host.to_account_info(),
                },
            ),
            stake,
        )?;
        Ok(())
    }

    /// The named guest pays in and the match is locked. From here the money can only move on a result
    /// the two of them agree on, or back to them.
    pub fn join(ctx: Context<Join>) -> Result<()> {
        let m = &mut ctx.accounts.game;
        require!(m.state == MatchState::Open, BetError::WrongState);
        require_keys_eq!(ctx.accounts.guest.key(), m.guest, BetError::NotYourMatch);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.guest_tokens.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.guest.to_account_info(),
                },
            ),
            m.stake,
        )?;
        m.state = MatchState::Locked;
        Ok(())
    }

    /// One player says who won. Saying the same thing twice is allowed, because that is what a retry
    /// after a dropped connection looks like. Changing the answer is not: otherwise whoever answered
    /// second could wait and then agree with whatever won them the match.
    pub fn claim(ctx: Context<Claim>, winner: Side) -> Result<()> {
        let m = &mut ctx.accounts.game;
        require!(m.state == MatchState::Locked, BetError::WrongState);
        let who = ctx.accounts.player.key();

        let slot = if who == m.host {
            &mut m.host_claim
        } else if who == m.guest {
            &mut m.guest_claim
        } else {
            return err!(BetError::NotYourMatch);
        };
        match slot {
            Some(already) => require!(*already == winner, BetError::AlreadyClaimed),
            None => *slot = Some(winner),
        }
        Ok(())
    }

    /// Both players agreed, so pay the winner and take the fee. The vault is emptied and closed in the
    /// same breath, so there is no path that leaves a settled match holding anything.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let m = &ctx.accounts.game;
        require!(m.state == MatchState::Locked, BetError::WrongState);
        let (host_claim, guest_claim) = match (m.host_claim, m.guest_claim) {
            (Some(a), Some(b)) => (a, b),
            _ => return err!(BetError::ResultIncomplete),
        };
        require!(host_claim == guest_claim, BetError::ResultDisputed);

        let winner = match host_claim {
            Side::Host => m.host,
            Side::Guest => m.guest,
        };
        require_keys_eq!(ctx.accounts.winner.key(), winner, BetError::WrongWinner);

        let (to_winner, fee) = split(m.stake, m.fee_bps)?;
        // Never pay out more than is actually there, whatever the arithmetic says.
        require!(
            ctx.accounts.vault.amount >= to_winner.checked_add(fee).ok_or(BetError::MathOverflow)?,
            BetError::VaultShort
        );

        let code = m.code;
        let bump = m.bump;
        let seeds: &[&[u8]] = &[MATCH_SEED, code.as_ref(), &[bump]];
        let signer: &[&[&[u8]]] = &[seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.winner_tokens.to_account_info(),
                    authority: ctx.accounts.game.to_account_info(),
                },
                signer,
            ),
            to_winner,
        )?;
        if fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.fee_tokens.to_account_info(),
                        authority: ctx.accounts.game.to_account_info(),
                    },
                    signer,
                ),
                fee,
            )?;
        }

        ctx.accounts.game.state = MatchState::Settled;
        close_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.host.to_account_info(),
            &ctx.accounts.game,
            signer,
        )?;
        emit!(Settled {
            code,
            winner,
            paid: to_winner,
            fee,
        });
        Ok(())
    }

    /// Nobody is paid and nobody is charged: each player takes back exactly what they put in. Open to
    /// either player once they have contradicted each other, and to either of them once the deadline
    /// has passed, which is what makes a walked-away match recoverable rather than stuck.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let m = &ctx.accounts.game;
        require!(m.state == MatchState::Locked, BetError::WrongState);
        let who = ctx.accounts.player.key();
        require!(who == m.host || who == m.guest, BetError::NotYourMatch);

        // An agreed result is final, and the deadline must not undo it. Without this the player who
        // lost could confirm that they lost, then simply press nothing: once the deadline passed they
        // could refund and take their stake back out of a result they had already agreed to. That gives
        // the loser a reason to stall, which is precisely backwards. Nothing is stranded by refusing,
        // because either player can settle an agreed result and it pays the same person either way.
        let agreed = matches!((m.host_claim, m.guest_claim), (Some(a), Some(b)) if a == b);
        require!(!agreed, BetError::AlreadyAgreed);
        let disputed = matches!((m.host_claim, m.guest_claim), (Some(a), Some(b)) if a != b);
        let expired = Clock::get()?.unix_timestamp >= m.deadline;
        require!(disputed || expired, BetError::NotRefundableYet);

        let stake = m.stake;
        require!(
            ctx.accounts.vault.amount >= stake.checked_mul(2).ok_or(BetError::MathOverflow)?,
            BetError::VaultShort
        );

        let code = m.code;
        let bump = m.bump;
        let seeds: &[&[u8]] = &[MATCH_SEED, code.as_ref(), &[bump]];
        let signer: &[&[&[u8]]] = &[seeds];

        for to in [
            ctx.accounts.host_tokens.to_account_info(),
            ctx.accounts.guest_tokens.to_account_info(),
        ] {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to,
                        authority: ctx.accounts.game.to_account_info(),
                    },
                    signer,
                ),
                stake,
            )?;
        }

        ctx.accounts.game.state = MatchState::Refunded;
        close_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.host.to_account_info(),
            &ctx.accounts.game,
            signer,
        )?;
        emit!(Refunded { code, each: stake });
        Ok(())
    }

    /// The invite was never taken up, so the host takes its stake back. Only possible while the match
    /// is still open, which is to say before anybody else's money is involved.
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        let m = &ctx.accounts.game;
        require!(m.state == MatchState::Open, BetError::WrongState);
        require_keys_eq!(ctx.accounts.host.key(), m.host, BetError::NotYourMatch);

        let stake = m.stake;
        let code = m.code;
        let bump = m.bump;
        let seeds: &[&[u8]] = &[MATCH_SEED, code.as_ref(), &[bump]];
        let signer: &[&[&[u8]]] = &[seeds];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.host_tokens.to_account_info(),
                    authority: ctx.accounts.game.to_account_info(),
                },
                signer,
            ),
            stake,
        )?;
        ctx.accounts.game.state = MatchState::Refunded;
        close_vault(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.host.to_account_info(),
            &ctx.accounts.game,
            signer,
        )?;
        emit!(Refunded { code, each: stake });
        Ok(())
    }
}

/// Hands the emptied vault's rent back to the host, who paid it. Called only after the balance has
/// been moved out, and the token program refuses to close an account still holding anything.
fn close_vault<'info>(
    token_program: &Program<'info, Token>,
    vault: &Account<'info, TokenAccount>,
    host: &AccountInfo<'info>,
    game: &Account<'info, Match>,
    signer: &[&[&[u8]]],
) -> Result<()> {
    token::close_account(CpiContext::new_with_signer(
        token_program.to_account_info(),
        CloseAccount {
            account: vault.to_account_info(),
            destination: host.clone(),
            authority: game.to_account_info(),
        },
        signer,
    ))
}

/* ---------- accounts ---------- */

#[derive(Accounts)]
#[instruction(code: [u8; CODE_LEN])]
pub struct Open<'info> {
    #[account(mut)]
    pub host: Signer<'info>,
    #[account(
        init,
        payer = host,
        space = 8 + Match::INIT_SPACE,
        seeds = [MATCH_SEED, code.as_ref()],
        bump
    )]
    pub game: Account<'info, Match>,
    pub mint: Account<'info, Mint>,
    /// The pot. Held by the match itself, so only this program can move it.
    #[account(
        init_if_needed,
        payer = host,
        associated_token::mint = mint,
        associated_token::authority = game
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = host
    )]
    pub host_tokens: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Join<'info> {
    #[account(mut)]
    pub guest: Signer<'info>,
    #[account(mut, seeds = [MATCH_SEED, game.code.as_ref()], bump = game.bump)]
    pub game: Account<'info, Match>,
    #[account(
        mut,
        associated_token::mint = game.mint,
        associated_token::authority = game
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = game.mint,
        associated_token::authority = guest
    )]
    pub guest_tokens: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    pub player: Signer<'info>,
    #[account(mut, seeds = [MATCH_SEED, game.code.as_ref()], bump = game.bump)]
    pub game: Account<'info, Match>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    /// Either player may send this once they agree; it pays the winner either way, so it does not
    /// matter which of them does it. Also pays for any token account that has to be made below.
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [MATCH_SEED, game.code.as_ref()], bump = game.bump)]
    pub game: Account<'info, Match>,
    #[account(
        mut,
        associated_token::mint = game.mint,
        associated_token::authority = game
    )]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: only ever a destination for rent, and checked against the recorded host.
    #[account(mut, address = game.host @ BetError::NotYourMatch)]
    pub host: UncheckedAccount<'info>,
    /// CHECK: checked against the agreed result inside settle.
    pub winner: UncheckedAccount<'info>,
    #[account(address = game.mint @ BetError::WrongMint)]
    pub mint: Account<'info, Mint>,
    /// Made here if it is missing, so a closed token account cannot strand a won pot.
    #[account(
        init_if_needed,
        payer = caller,
        associated_token::mint = mint,
        associated_token::authority = winner
    )]
    pub winner_tokens: Account<'info, TokenAccount>,
    /// CHECK: pinned to the FEE_WALLET constant. Present only so the fee token account below has an
    /// owner to be created against; nothing is read from it and it never signs.
    #[account(address = FEE_WALLET @ BetError::WrongFeeWallet)]
    pub fee_wallet: UncheckedAccount<'info>,
    /// The platform's cut. Its owner is pinned to the constant above, so no caller can send the fee
    /// elsewhere. Made here if missing: the fee wallet is nobody's to fix in a hurry, and without this
    /// the first payout of a given mint would fail with both stakes already locked in the vault.
    #[account(
        init_if_needed,
        payer = caller,
        associated_token::mint = mint,
        associated_token::authority = fee_wallet
    )]
    pub fee_tokens: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    pub player: Signer<'info>,
    #[account(mut, seeds = [MATCH_SEED, game.code.as_ref()], bump = game.bump)]
    pub game: Account<'info, Match>,
    #[account(
        mut,
        associated_token::mint = game.mint,
        associated_token::authority = game
    )]
    pub vault: Account<'info, TokenAccount>,
    /// CHECK: rent destination, checked against the recorded host.
    #[account(mut, address = game.host @ BetError::NotYourMatch)]
    pub host: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = game.mint,
        associated_token::authority = game.host
    )]
    pub host_tokens: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = game.mint,
        associated_token::authority = game.guest
    )]
    pub guest_tokens: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(mut, address = game.host @ BetError::NotYourMatch)]
    pub host: Signer<'info>,
    #[account(mut, seeds = [MATCH_SEED, game.code.as_ref()], bump = game.bump)]
    pub game: Account<'info, Match>,
    #[account(
        mut,
        associated_token::mint = game.mint,
        associated_token::authority = game
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = game.mint,
        associated_token::authority = game.host
    )]
    pub host_tokens: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

/* ---------- state ---------- */

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Side {
    Host,
    Guest,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum MatchState {
    /// Opened and paid for by the host; waiting for the guest.
    Open,
    /// Both stakes are in. Money can now only move on an agreed result, or back.
    Locked,
    /// Paid out.
    Settled,
    /// Everybody got their own stake back. No fee was taken.
    Refunded,
}

#[account]
#[derive(InitSpace)]
pub struct Match {
    pub code: [u8; CODE_LEN],
    pub mint: Pubkey,
    pub host: Pubkey,
    pub guest: Pubkey,
    /// Per player, in the mint's smallest unit. The pot is twice this.
    pub stake: u64,
    pub host_claim: Option<Side>,
    pub guest_claim: Option<Side>,
    pub state: MatchState,
    /// After this, either player can take their own stake back whatever the other one does.
    pub deadline: i64,
    /// Copied from FEE_BPS when the match opened, so the terms cannot change under way.
    pub fee_bps: u16,
    pub bump: u8,
}

#[event]
pub struct Settled {
    pub code: [u8; CODE_LEN],
    pub winner: Pubkey,
    pub paid: u64,
    pub fee: u64,
}

#[event]
pub struct Refunded {
    pub code: [u8; CODE_LEN],
    pub each: u64,
}

#[error_code]
pub enum BetError {
    #[msg("That match is not at the right stage for this.")]
    WrongState,
    #[msg("You are not in that match.")]
    NotYourMatch,
    #[msg("A stake has to be more than nothing.")]
    StakeTooSmall,
    #[msg("A staked match needs someone to play against.")]
    GuestMissing,
    #[msg("You cannot stake against yourself.")]
    PlayingYourself,
    #[msg("Pick a deadline between five minutes and a week away.")]
    BadDeadline,
    #[msg("You have already said who won.")]
    AlreadyClaimed,
    #[msg("Both players have to say who won before this can pay out.")]
    ResultIncomplete,
    #[msg("You two disagree on who won, so this can only be refunded.")]
    ResultDisputed,
    #[msg("That is not the player the two of you agreed had won.")]
    WrongWinner,
    #[msg("Nothing to refund yet: nobody disagrees and the deadline has not passed.")]
    NotRefundableYet,
    #[msg("You both agreed who won, so this pays out rather than refunds.")]
    AlreadyAgreed,
    #[msg("The pot does not hold what this match says it should.")]
    VaultShort,
    #[msg("That fee is higher than this program allows.")]
    FeeTooHigh,
    #[msg("That is not the token this match was staked in.")]
    WrongMint,
    #[msg("The platform fee can only go to the wallet built into this program.")]
    WrongFeeWallet,
    #[msg("The numbers went out of range.")]
    MathOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_percent_of_each_stake() {
        // 10 USDC each at six decimals: the winner takes 19.8 and 0.2 goes to the platform.
        let (won, fee) = split(10_000_000, FEE_BPS).unwrap();
        assert_eq!(won, 19_800_000);
        assert_eq!(fee, 200_000);
        assert_eq!(won + fee, 20_000_000, "every unit staked has to go somewhere");
    }

    #[test]
    fn nothing_is_created_or_lost_at_any_stake() {
        for stake in [1u64, 7, 99, 1_000, 10_000_000, u64::MAX / 4] {
            let (won, fee) = split(stake, FEE_BPS).unwrap();
            assert_eq!(won as u128 + fee as u128, stake as u128 * 2, "stake {}", stake);
        }
    }

    #[test]
    fn a_stake_too_small_to_carry_a_fee_carries_none() {
        // Rounding down favours the players rather than the platform.
        let (won, fee) = split(99, FEE_BPS).unwrap();
        assert_eq!(fee, 0);
        assert_eq!(won, 198);
    }

    #[test]
    fn a_fee_above_the_ceiling_is_refused() {
        assert!(split(10_000_000, MAX_FEE_BPS + 1).is_err());
        assert!(split(10_000_000, 10_000).is_err());
    }

    #[test]
    fn the_shipped_fee_is_one_percent() {
        assert_eq!(FEE_BPS, 100);
        assert!(FEE_BPS <= MAX_FEE_BPS);
    }
}

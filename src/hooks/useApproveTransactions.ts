import { MaxUint256 } from '@ethersproject/constants'
import { TransactionResponse } from '@ethersproject/providers'
import { CurrencyAmount, ETHER, TokenAmount, Trade } from '@sushiswap/sdk'
import { useCallback, useMemo } from 'react'
import { useTokenAllowance } from '../data/Allowances'
import { getTradeVersion, useV1TradeExchangeAddress } from '../data/V1'
import { Field } from '../state/swap/actions'
import { useHasPendingApproval, useTransactionAdder } from '../state/transactions/hooks'
import { calculateGasMargin, getRouterAddress } from '../utils'
import { computeSlippageAdjustedAmounts } from '../utils/prices'
import { useActiveWeb3React } from './useActiveWeb3React'
import { useTokenContract } from './useContract'
import { Version } from './useToggledVersion'

export enum ApprovalState {
    UNKNOWN,
    NOT_APPROVED,
    PENDING,
    APPROVED
}

interface GnosisTx {
    to: string
    value: string
    data: string
    gasLimit: string
}

// returns a variable indicating the state of the approval and a function which approves if necessary or early returns
export function useApproveTransaction(
    amountToApprove?: CurrencyAmount,
    spender?: string
): [ApprovalState, () => Promise<GnosisTx | undefined>] {
    const { account, chainId } = useActiveWeb3React()
    const token = amountToApprove instanceof TokenAmount ? amountToApprove.token : undefined
    const currentAllowance = useTokenAllowance(token, account ?? undefined, spender)
    const pendingApproval = useHasPendingApproval(token?.address, spender)

    // check the current approval status
    const approvalState: ApprovalState = useMemo(() => {
        if (!amountToApprove || !spender) return ApprovalState.UNKNOWN
        if (amountToApprove.currency === ETHER) return ApprovalState.APPROVED
        // we might not have enough data to know whether or not we need to approve
        if (!currentAllowance) return ApprovalState.UNKNOWN

        // amountToApprove will be defined if currentAllowance is
        return currentAllowance.lessThan(amountToApprove)
            ? pendingApproval
                ? ApprovalState.PENDING
                : ApprovalState.NOT_APPROVED
            : ApprovalState.APPROVED
    }, [amountToApprove, currentAllowance, pendingApproval, spender])

    const tokenContract = useTokenContract(token?.address)
    //const addTransaction = useTransactionAdder() // this?

    const approve = useCallback(async (): Promise<GnosisTx | undefined> => {
        if (approvalState !== ApprovalState.NOT_APPROVED) {
            console.error('approve was called unnecessarily')
            return
        }
        if (!token) {
            console.error('no token')
            return
        }

        if (!tokenContract) {
            console.error('tokenContract is null')
            return
        }

        if (!amountToApprove) {
            console.error('missing amount to approve')
            return
        }

        if (!spender) {
            console.error('no spender')
            return
        }

        let useExact = false
        const estimatedGas = await tokenContract.estimateGas.approve(spender, MaxUint256).catch(() => {
            // general fallback for tokens who restrict approval amounts
            useExact = true
            return tokenContract.estimateGas.approve(spender, amountToApprove.raw.toString())
        })

        const functionCall = tokenContract.interface.encodeFunctionData('approve', [
            spender,
            useExact ? amountToApprove.raw.toString() : MaxUint256
        ])

        const tx: GnosisTx = {
            to: tokenContract.address,
            value: '0',
            data: functionCall,
            gasLimit: calculateGasMargin(estimatedGas).toString()
        }

        return tx
    }, [approvalState, token, tokenContract, amountToApprove, spender, chainId])

    return [approvalState, approve]
}

// wraps useApproveCallback in the context of a swap
export function useApproveTransactionFromTrade(trade?: Trade, allowedSlippage = 0) {
    const amountToApprove = useMemo(
        () => (trade ? computeSlippageAdjustedAmounts(trade, allowedSlippage)[Field.INPUT] : undefined),
        [trade, allowedSlippage]
    )
    const tradeIsV1 = getTradeVersion(trade) === Version.v1
    const v1ExchangeAddress = useV1TradeExchangeAddress(trade)
    const { chainId } = useActiveWeb3React()
    return useApproveTransaction(amountToApprove, tradeIsV1 ? v1ExchangeAddress : getRouterAddress(chainId))
}

/*

  Copyright 2017 Loopring Project Ltd (Loopring Foundation).

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/
pragma solidity 0.5.7;

import "../../lib/BurnableERC20.sol";
import "../../lib/ERC20SafeTransfer.sol";
import "../../lib/MathUint.sol";
import "../../iface/IBlockVerifier.sol";

import "./ExchangeData.sol";
import "./ExchangeMode.sol";


/// @title ExchangeAccounts.
/// @author Brecht Devos - <brecht@loopring.org>
/// @author Daniel Wang  - <daniel@loopring.org>
library ExchangeBlocks
{
    using MathUint          for uint;
    using ExchangeMode      for ExchangeData.State;

    event BlockCommitted(
        uint    indexed blockIdx,
        bytes32 indexed publicDataHash
    );

    event BlockFinalized(
        uint    indexed blockIdx
    );

    event Revert(
        uint    indexed blockIdx
    );

    function commitBlock(
        ExchangeData.State storage S,
        uint8 blockType,
        uint16 numElements,
        bytes memory data
        )
        internal  // inline call
    {
        commitBlockInternal(S, blockType, numElements, data);
    }

    function verifyBlock(
        ExchangeData.State storage S,
        uint blockIdx,
        uint256[8] memory proof
        )
        internal  // inline call
    {
        // Exchange cannot be in withdrawal mode
        require(!S.isInWithdrawalMode(), "INVALID_MODE");
        require(blockIdx < S.blocks.length, "INVALID_BLOCK_IDX");

        ExchangeData.Block storage specifiedBlock = S.blocks[blockIdx];
        require(
            specifiedBlock.state == ExchangeData.BlockState.COMMITTED,
            "BLOCK_VERIFIED_ALREADY"
        );

        // Check if we still accept a proof for this block
        require(
            now <= specifiedBlock.timestamp + ExchangeData.MAX_PROOF_GENERATION_TIME_IN_SECONDS(),
            "PROOF_TOO_LATE"
        );

        require(
            S.blockVerifier.verifyProof(
                specifiedBlock.blockType,
                S.onchainDataAvailability,
                specifiedBlock.numElements,
                specifiedBlock.publicDataHash,
                proof
            ),
            "INVALID_PROOF"
        );

        // Update state of this block and potentially the following blocks
        ExchangeData.Block storage previousBlock = S.blocks[blockIdx - 1];
        if (previousBlock.state == ExchangeData.BlockState.FINALIZED) {
            specifiedBlock.state = ExchangeData.BlockState.FINALIZED;
            S.numBlocksFinalized = blockIdx + 1;
            emit BlockFinalized(blockIdx);
            // The next blocks could become finalized as well so check this now
            // The number of blocks after the specified block index is limited
            // so we don't have to worry about running out of gas in this loop
            uint nextBlockIdx = blockIdx + 1;
            while (nextBlockIdx < S.blocks.length &&
                S.blocks[nextBlockIdx].state == ExchangeData.BlockState.VERIFIED) {

                S.blocks[nextBlockIdx].state = ExchangeData.BlockState.FINALIZED;
                S.numBlocksFinalized = nextBlockIdx + 1;
                emit BlockFinalized(nextBlockIdx);
                nextBlockIdx++;
            }
        } else {
            specifiedBlock.state = ExchangeData.BlockState.VERIFIED;
        }
    }

    function revertBlock(
        ExchangeData.State storage S,
        uint blockIdx
        )
        public
    {
        // Exchange cannot be in withdrawal mode
        require(!S.isInWithdrawalMode(), "INVALID_MODE");

        require(blockIdx < S.blocks.length, "INVALID_BLOCK_IDX");
        ExchangeData.Block storage specifiedBlock = S.blocks[blockIdx];
        require(specifiedBlock.state == ExchangeData.BlockState.COMMITTED, "INVALID_BLOCK_STATE");

        // The specified block needs to be the first block not finalized
        // (this way we always revert to a guaranteed valid block and don't need to revert multiple times)
        ExchangeData.Block storage previousBlock = S.blocks[uint(blockIdx).sub(1)];
        require(previousBlock.state == ExchangeData.BlockState.FINALIZED, "PREV_BLOCK_NOT_FINALIZED");

        // Check if this block is verified too late
        require(
            now > specifiedBlock.timestamp + ExchangeData.MAX_PROOF_GENERATION_TIME_IN_SECONDS(),
            "PROOF_NOT_TOO_LATE"
        );
        // Burn the complete stake of the exchange
        S.loopring.burnAllStake(S.id);

        // Remove all blocks after and including blockIdx
        S.blocks.length = blockIdx;

        emit Revert(blockIdx);
    }

    // == Internal Functions ==
    function commitBlockInternal(
        ExchangeData.State storage S,
        uint8 blockType,
        uint16 numElements,
        bytes memory data   // This field already has all the dummy (0-valued) requests padded,
                            // therefore the size of this field totally depends on
                            // `numElements` instead of the actual user requests processed
                            // in this block. This is fine because 0-bytes consume fewer gas.
        )
        private
    {
        // Exchange cannot be in withdrawal mode
        require(!S.isInWithdrawalMode(), "INVALID_MODE");

        // TODO: Check if this exchange has a minimal amount of LRC staked?

        require(
            S.blockVerifier.canVerify(blockType, S.onchainDataAvailability, numElements),
            "CANNOT_VERIFY_BLOCK"
        );

        // Extract the exchange ID from the data
        uint32 exchangeIdInData = 0;
        assembly {
            exchangeIdInData := and(mload(add(data, 4)), 0xFFFFFFFF)
        }
        require(exchangeIdInData == S.id, "INVALID_EXCHANGE_ID");

        // Get the current block
        ExchangeData.Block storage prevBlock = S.blocks[S.blocks.length - 1];

        // Get the old and new Merkle roots
        bytes32 merkleRootBefore;
        bytes32 merkleRootAfter;
        assembly {
            merkleRootBefore := mload(add(data, 36))
            merkleRootAfter := mload(add(data, 68))
        }
        require(merkleRootBefore == prevBlock.merkleRoot, "INVALID_MERKLE_ROOT");

        uint32 numDepositRequestsCommitted = uint32(prevBlock.numDepositRequestsCommitted);
        uint32 numWithdrawalRequestsCommitted = uint32(prevBlock.numWithdrawalRequestsCommitted);

        // When the exchange is shutdown:
        // - First force all outstanding deposits to be done
        // - Allow withdrawing using the special shutdown mode of ONCHAIN_WITHDRAWAL (with
        //   count == 0)
        if (S.isShutdown()) {
            if (numDepositRequestsCommitted < S.depositChain.length) {
                require(blockType == uint(ExchangeData.BlockType.DEPOSIT), "SHUTDOWN_DEPOSIT_BLOCK_FORCED");
            } else {
                require(blockType == uint(ExchangeData.BlockType.ONCHAIN_WITHDRAWAL), "SHUTDOWN_WITHDRAWAL_BLOCK_FORCED");
            }
        }

        // Check if the operator is forced to commit a deposit or withdraw block
        // We give priority to withdrawals. If a withdraw block is forced it needs to
        // be processed first, even if there is also a deposit block forced.
        if (isWithdrawalRequestForced(S, numWithdrawalRequestsCommitted)) {
            require(blockType == uint(ExchangeData.BlockType.ONCHAIN_WITHDRAWAL), "WITHDRAWAL_BLOCK_FORCED");
        } else if (isDepositRequestForced(S, numDepositRequestsCommitted)) {
            require(blockType == uint(ExchangeData.BlockType.DEPOSIT), "DEPOSIT_BLOCK_FORCED");
        }

        if (blockType == uint(ExchangeData.BlockType.RING_SETTLEMENT)) {
            require(now >= S.disableUserRequestsUntil, "SETTLEMENT_SUSPENDED");
            uint32 inputTimestamp;
            assembly {
                inputTimestamp := and(mload(add(data, 72)), 0xFFFFFFFF)
            }
            require(
                inputTimestamp > now - ExchangeData.TIMESTAMP_HALF_WINDOW_SIZE_IN_SECONDS() &&
                inputTimestamp < now + ExchangeData.TIMESTAMP_HALF_WINDOW_SIZE_IN_SECONDS(),
                "INVALID_TIMESTAMP"
            );
        } else if (blockType == uint(ExchangeData.BlockType.DEPOSIT)) {
            uint startIdx = 0;
            uint count = 0;
            assembly {
                startIdx := and(mload(add(data, 136)), 0xFFFFFFFF)
                count := and(mload(add(data, 140)), 0xFFFFFFFF)
            }
            require (startIdx == numDepositRequestsCommitted, "INVALID_REQUEST_RANGE");
            require (count <= numElements, "INVALID_REQUEST_RANGE");
            require (startIdx + count <= S.depositChain.length, "INVALID_REQUEST_RANGE");

            bytes32 startingHash = S.depositChain[startIdx - 1].accumulatedHash;
            bytes32 endingHash = S.depositChain[startIdx + count - 1].accumulatedHash;
            // Pad the block so it's full
            for (uint i = count; i < numElements; i++) {
                endingHash = sha256(
                    abi.encodePacked(
                        endingHash,
                        uint24(0),
                        uint256(0),
                        uint256(0),
                        uint16(0),
                        uint96(0)
                    )
                );
            }
            bytes32 inputStartingHash = 0x0;
            bytes32 inputEndingHash = 0x0;
            assembly {
                inputStartingHash := mload(add(data, 100))
                inputEndingHash := mload(add(data, 132))
            }
            require(inputStartingHash == startingHash, "INVALID_STARTING_HASH");
            require(inputEndingHash == endingHash, "INVALID_ENDING_HASH");

            numDepositRequestsCommitted += uint32(count);
        } else if (blockType == uint(ExchangeData.BlockType.ONCHAIN_WITHDRAWAL)) {
            uint startIdx = 0;
            uint count = 0;
            assembly {
                startIdx := and(mload(add(data, 136)), 0xFFFFFFFF)
                count := and(mload(add(data, 140)), 0xFFFFFFFF)
            }
            require (startIdx == numWithdrawalRequestsCommitted, "INVALID_REQUEST_RANGE");
            require (count <= numElements, "INVALID_REQUEST_RANGE");
            require (startIdx + count <= S.withdrawalChain.length, "INVALID_REQUEST_RANGE");

            if (S.isShutdown()) {
                require (count == 0, "INVALID_WITHDRAWAL_COUNT");
                // Don't check anything here, the operator can do all necessary withdrawals
                // in any order he wants (the circuit still ensures the withdrawals are valid)
            } else {
                require (count > 0, "INVALID_WITHDRAWAL_COUNT");
                bytes32 startingHash = S.withdrawalChain[startIdx - 1].accumulatedHash;
                bytes32 endingHash = S.withdrawalChain[startIdx + count - 1].accumulatedHash;
                // Pad the block so it's full
                for (uint i = count; i < numElements; i++) {
                    endingHash = sha256(
                        abi.encodePacked(
                            endingHash,
                            uint24(0),
                            uint16(0),
                            uint96(0)
                        )
                    );
                }
                bytes32 inputStartingHash = 0x0;
                bytes32 inputEndingHash = 0x0;
                assembly {
                    inputStartingHash := mload(add(data, 100))
                    inputEndingHash := mload(add(data, 132))
                }
                require(inputStartingHash == startingHash, "INVALID_STARTING_HASH");
                require(inputEndingHash == endingHash, "INVALID_ENDING_HASH");
                numWithdrawalRequestsCommitted += uint32(count);

            }
        } else if (blockType == uint(ExchangeData.BlockType.OFFCHAIN_WITHDRAWAL)) {
            // Do nothing
        } else if (blockType == uint(ExchangeData.BlockType.ORDER_CANCELLATION)) {
            // Do nothing
        } else {
            revert("UNSUPPORTED_BLOCK_TYPE");
        }

        // Hash all the public data to a single value which is used as the input for the circuit
        bytes32 publicDataHash = sha256(data);

        // Only store the approved withdrawal data onchain
        if (blockType == uint(ExchangeData.BlockType.ONCHAIN_WITHDRAWAL) ||
            blockType == uint(ExchangeData.BlockType.OFFCHAIN_WITHDRAWAL)) {
            uint start = 4 + 32 + 32;
            if (blockType == uint(ExchangeData.BlockType.ONCHAIN_WITHDRAWAL)) {
                start += 32 + 32 + 4 + 4;
            }
            uint length = (3 + 2 + 12) * numElements;
            assembly {
                data := add(data, start)
                mstore(data, length)
            }
        }

        // Create a new block with the updated merkle roots
        ExchangeData.Block memory newBlock = ExchangeData.Block(
            merkleRootAfter,
            publicDataHash,
            ExchangeData.BlockState.COMMITTED,
            blockType,
            numElements,
            uint32(now),
            numDepositRequestsCommitted,
            numWithdrawalRequestsCommitted,
            false,
            0,
            (blockType == uint(ExchangeData.BlockType.ONCHAIN_WITHDRAWAL) ||
             blockType == uint(ExchangeData.BlockType.OFFCHAIN_WITHDRAWAL)) ? data : new bytes(0)
        );

        S.blocks.push(newBlock);

        emit BlockCommitted(S.blocks.length - 1, publicDataHash);
    }

    function isDepositRequestForced(
        ExchangeData.State storage S,
        uint numRequestsCommitted
        )
        private
        view
        returns (bool)
    {
        if (numRequestsCommitted == S.depositChain.length) {
            return false;
        } else {
            return S.depositChain[numRequestsCommitted].timestamp < now.sub(
                ExchangeData.MAX_AGE_REQUEST_UNTIL_FORCED());
        }
    }

    function isWithdrawalRequestForced(
        ExchangeData.State storage S,
        uint numRequestsCommitted
        )
        private
        view
        returns (bool)
    {
        if (numRequestsCommitted == S.withdrawalChain.length) {
            return false;
        } else {
            return S.withdrawalChain[numRequestsCommitted].timestamp < now.sub(
                ExchangeData.MAX_AGE_REQUEST_UNTIL_FORCED());
        }
    }
}

import BN = require("bn.js");
import { expectThrow } from "./expectThrow";
import { ExchangeTestUtil } from "./testExchangeUtil";
import { DepositInfo, RingInfo } from "./types";

contract("Exchange", (accounts: string[]) => {

  let exchangeTestUtil: ExchangeTestUtil;
  let exchange: any;
  let loopring: any;
  let realmID = 0;

  const createOrUpdateAccountChecked = async (keyPair: any, owner: string, fee: BN) => {
    const numAvailableSlotsBefore = (await exchange.getNumAvailableDepositSlots()).toNumber();

    await exchange.createOrUpdateAccount(keyPair.publicKeyX, keyPair.publicKeyY,
      {from: owner, value: fee, gasPrice: 0});

    const numAvailableSlotsAfter = (await exchange.getNumAvailableDepositSlots()).toNumber();

    assert.equal(numAvailableSlotsBefore, numAvailableSlotsAfter,
           "Number of available deposit slots should stay the same");

    // Get the AccountCreated event
    const eventArr: any = await exchangeTestUtil.getEventsFromContract(
      exchange, "AccountCreated", web3.eth.blockNumber,
    );
    const items = eventArr.map((eventObj: any) => {
      return [eventObj.args.id];
    });
    assert.equal(items.length, 1, "A single AccountCreated event should have been emitted");
    const accountID = items[0][0].toNumber();
    return accountID;
  };

  const createFeeRecipientAccountChecked = async (owner: string, fee: BN) => {
    const numAvailableSlotsBefore = (await exchange.getNumAvailableDepositSlots()).toNumber();

    await exchange.createFeeRecipientAccount({from: owner, value: fee, gasPrice: 0});

    const numAvailableSlotsAfter = (await exchange.getNumAvailableDepositSlots()).toNumber();

    assert.equal(numAvailableSlotsBefore, numAvailableSlotsAfter + 1,
           "Number of available deposit slots should have been decreased by 1");

    // Get the AccountCreated event
    const eventArr: any = await exchangeTestUtil.getEventsFromContract(
      exchange, "AccountCreated", web3.eth.blockNumber,
    );
    const items = eventArr.map((eventObj: any) => {
      return [eventObj.args.id];
    });
    assert.equal(items.length, 1, "A single AccountCreated event should have been emitted");
    const accountID = items[0][0].toNumber();
    return accountID;
  };

  const depositChecked = async (accountID: number, token: string, amount: BN,
                                owner: string, depositFee: BN) => {
    const balanceOwnerBefore = await exchangeTestUtil.getOnchainBalance(owner, token);
    const balanceContractBefore = await exchangeTestUtil.getOnchainBalance(exchange.address, token);
    const numAvailableSlotsBefore = (await exchange.getNumAvailableDepositSlots()).toNumber();

    const ethAddress = exchangeTestUtil.getTokenAddress("ETH");
    const ethValue = (token === ethAddress) ? amount.add(depositFee) : depositFee;
    await exchange.deposit(token, amount, {from: owner, value: ethValue, gasPrice: 0});

    const balanceOwnerAfter = await exchangeTestUtil.getOnchainBalance(owner, token);
    const balanceContractAfter = await exchangeTestUtil.getOnchainBalance(exchange.address, token);
    const numAvailableSlotsAfter = (await exchange.getNumAvailableDepositSlots()).toNumber();

    const expectedBalanceDelta = (token === ethAddress) ? amount.add(depositFee) : amount;
    assert(balanceOwnerBefore.eq(balanceOwnerAfter.add(expectedBalanceDelta)),
           "Token balance of owner should be decreased by amount");
    assert(balanceContractAfter.eq(balanceContractBefore.add(expectedBalanceDelta)),
           "Token balance of contract should be increased by amount");

    assert.equal(numAvailableSlotsBefore, numAvailableSlotsAfter + 1,
           "Number of available deposit slots should have been decreased by 1");

    // Get the Deposit event
    const eventArr: any = await exchangeTestUtil.getEventsFromContract(
      exchange, "DepositRequested", web3.eth.blockNumber,
    );
    const items = eventArr.map((eventObj: any) => {
      return [eventObj.args.accountID, eventObj.args.depositIdx];
    });
    assert.equal(items.length, 1, "A single Deposit event should have been emitted");
    assert.equal(items[0][0].toNumber(), accountID, "Deposit accountID should match");
  };

  const updateAccountChecked = async (accountID: number, keyPair: any,
                                      token: string, amount: BN,
                                      owner: string, depositFee: BN) => {
    const balanceOwnerBefore = await exchangeTestUtil.getOnchainBalance(owner, token);
    const balanceContractBefore = await exchangeTestUtil.getOnchainBalance(exchange.address, token);
    const numAvailableSlotsBefore = (await exchange.getNumAvailableDepositSlots()).toNumber();

    const ethValue = (token === "ETH") ? amount.add(depositFee) : depositFee;
    await exchange.updateAccountAndDeposit(keyPair.publicKeyX, keyPair.publicKeyY,
                                           token, amount, {from: owner, value: ethValue, gasPrice: 0});

    const balanceOwnerAfter = await exchangeTestUtil.getOnchainBalance(owner, token);
    const balanceContractAfter = await exchangeTestUtil.getOnchainBalance(exchange.address, token);
    const numAvailableSlotsAfter = (await exchange.getNumAvailableDepositSlots()).toNumber();

    const expectedBalanceDelta = (token === "ETH") ? amount.add(depositFee) : amount;
    assert(balanceOwnerBefore.eq(balanceOwnerAfter.add(expectedBalanceDelta)),
           "Token balance of owner should be decreased by amount");
    assert(balanceContractAfter.eq(balanceContractBefore.add(expectedBalanceDelta)),
           "Token balance of contract should be increased by amount");
    assert.equal(numAvailableSlotsBefore, numAvailableSlotsAfter + 1,
           "Number of available deposit slots should have been decreased by 1");

    // Get the Deposit event
    const eventArr: any = await exchangeTestUtil.getEventsFromContract(
      exchange, "DepositRequested", web3.eth.blockNumber,
    );
    const items = eventArr.map((eventObj: any) => {
      return [eventObj.args.accountID, eventObj.args.depositIdx];
    });
    assert.equal(items.length, 1, "A single Deposit event should have been emitted");
    assert.equal(items[0][0].toNumber(), accountID, "Deposit accountID should match");
  };

  const withdrawOnceChecked = async (blockIdx: number, slotIdx: number,
                                     accountID: number, token: string,
                                     owner: string, expectedAmount: BN, bBurn: boolean = false) => {
    const balanceOwnerBefore = await exchangeTestUtil.getOnchainBalance(owner, token);
    const balanceContractBefore = await exchangeTestUtil.getOnchainBalance(exchange.address, token);
    // const burnBalanceBefore = await exchange.burnBalances(token);

    await exchange.withdrawFromApprovedWithdrawal(blockIdx, slotIdx);

    const balanceOwnerAfter = await exchangeTestUtil.getOnchainBalance(owner, token);
    const balanceContractAfter = await exchangeTestUtil.getOnchainBalance(exchange.address, token);
    // const burnBalanceAfter = await exchange.burnBalances(token);

    let amountToOwner = expectedAmount;
    let amountToBurn = new BN(0);
    if (bBurn) {
      const burnRate = await exchangeTestUtil.loopringV3.getTokenBurnRate(token);
      amountToBurn = expectedAmount.mul(burnRate).div(new BN(10000));
      amountToOwner = expectedAmount.sub(amountToBurn);
    }
    assert(balanceOwnerAfter.eq(balanceOwnerBefore.add(amountToOwner)),
           "Token balance of owner should be increased by amountToOwner");
    assert(balanceContractBefore.eq(balanceContractAfter.add(amountToOwner).add(amountToBurn)),
           "Token balance of contract should be decreased by amountToOwner + amountToBurn");
    /*assert(burnBalanceAfter.eq(burnBalanceBefore.add(amountToBurn)),
           "burnBalance should be increased by amountToBurn");*/

    // Get the Withdraw event
    const eventArr: any = await exchangeTestUtil.getEventsFromContract(
      exchange, "WithdrawalCompleted", web3.eth.blockNumber,
    );
    const items = eventArr.map((eventObj: any) => {
      return [eventObj.args.accountID, eventObj.args.tokenID, eventObj.args.amount];
    });

    if (expectedAmount.gt(new BN(0))) {
      assert.equal(items.length, 1, "A single WithdrawalCompleted event should have been emitted");
      assert.equal(items[0][0].toNumber(), accountID, "accountID should match");
      // assert.equal(items[0][1].toNumber(), tokenID, "tokenID should match");
      assert(items[0][2].eq(expectedAmount), "amount should match");
    } else {
      assert.equal(items.length, 0, "No WithdrawalCompleted event should have been emitted");
    }
  };

  const withdrawChecked = async (blockIdx: number, slotIdx: number,
                                 accountID: number, token: string,
                                 owner: string, expectedAmount: BN, bBurn: boolean = false) => {
    // Withdraw
    await withdrawOnceChecked(blockIdx, slotIdx,
                              accountID, token,
                              owner, expectedAmount, bBurn);
    // Withdraw again, no tokens should be transferred
    await withdrawOnceChecked(blockIdx, slotIdx,
                              accountID, token,
                              owner, new BN(0), bBurn);
  };

  const distributeWithdrawalsChecked = async (blockIdx: number, deposits: DepositInfo[],
                                              from: string, tooLate: boolean = false) => {
    const LRC = await exchangeTestUtil.getTokenContract("LRC");
    // Balances owners
    const balanceOwnerBefore: BN[] = [];
    for (const deposit of deposits) {
      balanceOwnerBefore.push(await exchangeTestUtil.getOnchainBalance(deposit.owner, deposit.token));
    }
    // Balances contract
    const balancesContractBefore: BN[] = [];
    const balancesContractExpected: BN[] = [];
    for (let i = 0; i < exchangeTestUtil.MAX_NUM_TOKENS; i++) {
      balancesContractBefore.push(new BN(0));
      balancesContractExpected.push(new BN(0));
      const token = exchangeTestUtil.getTokenAddressFromID(i);
      if (token) {
        const balance = await exchangeTestUtil.getOnchainBalance(exchange.address, token);
        balancesContractBefore[i] = balance;
        balancesContractExpected[i] = balance;
      }
    }
    // Exchange stake
    const stakeBefore = await exchange.getStake();
    const totalStakeBefore = await loopring.totalStake();
    // LRC balance from
    const balanceFromBefore = await exchangeTestUtil.getOnchainBalance(from, "LRC");
    // LRC supply
    const lrcSupplyBefore = await LRC.totalSupply();

    // Distribute the withdrawals
    const tx = await exchange.distributeWithdrawals(blockIdx, {from});
    console.log("\x1b[46m%s\x1b[0m", "[DistributeWithdrawals] Gas used: " + tx.receipt.gasUsed);

    // Check balances owners
    const balanceOwnerAfter: BN[] = [];
    for (const deposit of deposits) {
      balanceOwnerAfter.push(await exchangeTestUtil.getOnchainBalance(deposit.owner, deposit.token));
      const tokenID = await exchangeTestUtil.getTokenID(deposit.token);
      balancesContractExpected[tokenID] = balancesContractExpected[tokenID].sub(deposit.amount);
    }
    for (let i = 0; i < deposits.length; i++) {
      assert(balanceOwnerAfter[i].eq(balanceOwnerBefore[i].add(deposits[i].amount)),
           "Token balance of owner should be increased by amountToOwner");
    }
    // Check balances contract
    for (let i = 0; i < exchangeTestUtil.MAX_NUM_TOKENS; i++) {
      const token = exchangeTestUtil.getTokenAddressFromID(i);
      if (token) {
        const balance = await exchangeTestUtil.getOnchainBalance(exchange.address, token);
        assert(balance.eq(balancesContractExpected[i]), "Token balance of contract incorrect");
      }
    }
    // Check stake
    const stakeAfter = await exchange.getStake();
    const totalStakeAfter = await loopring.totalStake();
    // LRC balance from
    const balanceFromAfter = await exchangeTestUtil.getOnchainBalance(from, "LRC");
    // LRC supply
    const lrcSupplyAfter = await LRC.totalSupply();
    if (tooLate) {
      // Stake reduced by withdrawalFineLRC * numWithdrawals
      const withdrawalFineLRC = await loopring.withdrawalFineLRC();
      const totalFine = withdrawalFineLRC.mul(new BN(deposits.length));
      assert(stakeAfter.eq(stakeBefore.sub(totalFine)), "Stake not reduced correctly by fine");
      assert(totalStakeAfter.eq(totalStakeBefore.sub(totalFine)), "Total stake not reduced correctly by fine");
      // Distributer gets paid half the fine
      const reward = totalFine.div(new BN(2));
      assert(balanceFromAfter.eq(balanceFromBefore.add(reward)), "distributer should be rewarded 50% of fine");
      // Half is burned
      const burned = totalFine.sub(reward);
      assert(lrcSupplyAfter.eq(lrcSupplyBefore.sub(burned)), "half of fine should be burned");
    } else {
      // Stake remains the same
      assert(stakeAfter.eq(stakeBefore), "Stake should remain the same");
      assert(totalStakeAfter.eq(totalStakeBefore), "Total stake should remain the same");
      // Operator doesn't get paid
      assert(balanceFromAfter.eq(balanceFromBefore), "Operator doesn't get rewarded");
      // Nothing is burned
      assert(lrcSupplyAfter.eq(lrcSupplyBefore), "No LRC burned");
    }
  };

  const createExchange = async (bSetupTestState: boolean = true) => {
    realmID = await exchangeTestUtil.createExchange(exchangeTestUtil.testContext.stateOwners[0], bSetupTestState);
    exchange = exchangeTestUtil.exchange;
  };

  before( async () => {
    exchangeTestUtil = new ExchangeTestUtil();
    await exchangeTestUtil.initialize(accounts);
    exchange = exchangeTestUtil.exchange;
    loopring = exchangeTestUtil.loopringV3;
    realmID = 1;
  });

  describe("DepositWithdraw", function() {
    this.timeout(0);

    it("Create account", async () => {
      await createExchange();

      const keyPair = exchangeTestUtil.getKeyPairEDDSA();
      const owner = exchangeTestUtil.testContext.orderOwners[0];

      // The correct deposit fee expected by the contract
      const fees = await exchange.getFees();
      const acountCreationFee = fees._accountCreationFeeETH;

      // No ETH sent
      await expectThrow(
        exchange.createOrUpdateAccount(keyPair.publicKeyX, keyPair.publicKeyY,
          {from: owner, value: new BN(0)}),
        "INSUFFICIENT_FEE",
      );
      // Not enough ETH
      await expectThrow(
        exchange.createOrUpdateAccount(keyPair.publicKeyX, keyPair.publicKeyY,
          {from: owner, value: acountCreationFee.sub(new BN(1))}),
        "INSUFFICIENT_FEE",
      );

      // Everything correct
      const accountID = await createOrUpdateAccountChecked(keyPair, owner, acountCreationFee);
      assert(accountID > 0);
    });

    it("ERC20: Deposit", async () => {
      await createExchange();

      let keyPair = exchangeTestUtil.getKeyPairEDDSA();
      const owner = exchangeTestUtil.testContext.orderOwners[0];
      let amount = new BN(web3.utils.toWei("7", "ether"));
      let token = exchangeTestUtil.getTokenAddress("LRC");

      // The correct deposit fee expected by the contract
      const fees = await exchange.getFees();
      const acountCreationFee = fees._accountCreationFeeETH;
      const depositFee = fees._depositFeeETH;
      const updateFee = fees._accountUpdateFeeETH;

      // Create the account
      const accountID = await createOrUpdateAccountChecked(keyPair, owner, acountCreationFee);

      // No ETH sent
      await expectThrow(
        exchange.deposit(token, amount, {from: owner, value: new BN(0)}),
        "INSUFFICIENT_FEE",
      );
      // Not enough ETH
      await expectThrow(
        exchange.deposit(token, amount, {from: owner, value: depositFee.sub(new BN(1))}),
        "INSUFFICIENT_FEE",
      );

      // Insufficient funds
      await exchangeTestUtil.setBalanceAndApprove(owner, token, amount.sub(new BN(1)));
      await expectThrow(
        exchange.deposit(token, amount, {from: owner, value: depositFee}),
        "INSUFFICIENT_FUND",
      );

      // Set the correct balance/approval
      await exchangeTestUtil.setBalanceAndApprove(owner, token, amount);

      // Invalid token
      await expectThrow(
        exchange.deposit(owner, amount, {from: owner, value: depositFee}),
        "TOKEN_NOT_FOUND",
      );

      // Do deposit to the same account with another token
      token = exchangeTestUtil.getTokenAddress("WETH");
      amount = new BN(web3.utils.toWei("4.5", "ether"));

      // New balance/approval for another deposit
      await exchangeTestUtil.setBalanceAndApprove(owner, token, amount);

      // Unknown owner
      const wrongOwner = exchangeTestUtil.testContext.orderOwners[8];
      await expectThrow(
        exchange.deposit(token, amount, {from: wrongOwner, value: depositFee}),
        "SENDER_HAS_NO_ACCOUNT",
      );

      // Everything correct
      await depositChecked(accountID, token, amount, owner, depositFee);

      // Change some account info
      amount = new BN(0);
      keyPair = exchangeTestUtil.getKeyPairEDDSA();

      // Change the publicKey
      await updateAccountChecked(accountID, keyPair, token,  amount, owner, depositFee.add(updateFee));
    });

    it("ETH: Deposit", async () => {
      await createExchange(false);

      const keyPair = exchangeTestUtil.getKeyPairEDDSA();
      const owner = exchangeTestUtil.testContext.orderOwners[0];
      const amount = new BN(web3.utils.toWei("3", "ether"));
      const token = exchangeTestUtil.getTokenAddress("ETH");

      // The correct deposit fee expected by the contract
      const fees = await exchange.getFees();
      const acountCreationFee = fees._accountCreationFeeETH;
      const depositFee = fees._depositFeeETH;

      // Create the account
      const accountID = await createOrUpdateAccountChecked(keyPair, owner, acountCreationFee);

      // No ETH sent
      await expectThrow(
        exchange.deposit(token, amount, {from: owner, value: new BN(0)}),
        "INSUFFICIENT_FEE",
      );

      // Not enough ETH
      await expectThrow(
        exchange.deposit(token, amount, {from: owner, value: amount}),
        "INSUFFICIENT_FEE",
      );

      // Everything correct
      await depositChecked(accountID, token, amount, owner, depositFee);
    });

    it("Fee recipient account", async () => {
      await createExchange(false);

      const keyPair = exchangeTestUtil.getKeyPairEDDSA();
      const owner = exchangeTestUtil.testContext.orderOwners[0];
      let amount = new BN(0);
      const token = exchangeTestUtil.getTokenAddress("ETH");

      // The correct deposit fee expected by the contract
      const fees = await exchange.getFees();
      const acountCreationFee = fees._accountCreationFeeETH;
      const depositFee = fees._depositFeeETH;
      const updateFee = fees._accountUpdateFeeETH;

      // Everything correct
      const totalFee = acountCreationFee.add(depositFee);
      const accountID = await createFeeRecipientAccountChecked(owner, totalFee);

      // Try to change the type of the account
      await expectThrow(
        exchange.createOrUpdateAccount(
          keyPair.publicKeyX, keyPair.publicKeyY, {from: owner, value: updateFee},
        ),
        "UPDATE_FEE_RECEPIENT_ACCOUNT_NOT_ALLOWED",
      );

      // Try to deposit to the account
      amount = new BN(web3.utils.toWei("3", "ether"));
      await expectThrow(
        exchange.deposit(token, amount, {from: owner, value: depositFee}),
        "INVALID_ACCOUNT_TYPE",
      );
    });

    it("Onchain withdrawal request", async () => {
      await createExchange();

      const keyPair = exchangeTestUtil.getKeyPairEDDSA();
      const ownerA = exchangeTestUtil.testContext.orderOwners[0];
      const ownerB = exchangeTestUtil.testContext.orderOwners[1];
      const balance = new BN(web3.utils.toWei("7", "ether"));
      const toWithdraw = new BN(web3.utils.toWei("4", "ether"));
      const token = exchangeTestUtil.getTokenAddress("LRC");
      const one = new BN(1);

      const depositInfo = await exchangeTestUtil.deposit(realmID, ownerA,
                                                         keyPair.secretKey, keyPair.publicKeyX, keyPair.publicKeyY,
                                                         token, balance);
      const accountID = depositInfo.accountID;
      await exchangeTestUtil.commitDeposits(realmID);

      const withdrawalFee = (await exchange.getFees())._withdrawalFeeETH;

      // No ETH sent
      await expectThrow(
        exchange.withdraw(token, toWithdraw, {from: ownerA, value: new BN(0)}),
        "INSUFFICIENT_FEE",
      );
      // Not enough ETH sent
      await expectThrow(
        exchange.withdraw(token, toWithdraw, {from: ownerA, value: withdrawalFee.sub(one)}),
        "INSUFFICIENT_FEE",
      );

      // Try to withdraw nothing
      await expectThrow(
        exchange.withdraw(token, new BN(0), {from: ownerA, value: withdrawalFee}),
        "ZERO_VALUE",
      );

      // Do the request
      const witdrawalRequest = await exchangeTestUtil.requestWithdrawalOnchain(
        realmID, accountID, token, toWithdraw, ownerA,
      );

      // Commit the deposit
      await exchangeTestUtil.commitOnchainWithdrawalRequests(realmID);
      // Verify the block
      await exchangeTestUtil.verifyPendingBlocks(realmID);

      // Withdraw
      const blockIdx = (await exchange.getBlockHeight()).toNumber();
      await withdrawChecked(blockIdx, witdrawalRequest.slotIdx,
                            accountID, token,
                            ownerA, toWithdraw);
    });

    it("Offchain withdrawal request (token == feeToken)", async () => {
      await createExchange();

      const keyPair = exchangeTestUtil.getKeyPairEDDSA();
      const owner = exchangeTestUtil.testContext.orderOwners[0];
      const wallet = exchangeTestUtil.wallets[realmID][0];
      const balance = new BN(web3.utils.toWei("4", "ether"));
      const toWithdraw = new BN(web3.utils.toWei("5", "ether"));
      const token = "ETH";
      const feeToken = "ETH";
      const fee = new BN(web3.utils.toWei("0.5", "ether"));

      const depositInfo = await exchangeTestUtil.deposit(realmID, owner,
                                                         keyPair.secretKey, keyPair.publicKeyX, keyPair.publicKeyY,
                                                         token, balance);
      const accountID = depositInfo.accountID;
      await exchangeTestUtil.commitDeposits(realmID);

      const witdrawalRequest = await exchangeTestUtil.requestWithdrawalOffchain(
        realmID, accountID, token, toWithdraw,
        feeToken, fee, 20, wallet.walletAccountID,
      );
      await exchangeTestUtil.commitOffchainWithdrawalRequests(realmID);
      await exchangeTestUtil.verifyPendingBlocks(realmID);

      // Withdraw
      const blockIdx = (await exchange.getBlockHeight()).toNumber();
      await withdrawChecked(blockIdx, 0,
                            accountID, token,
                            owner, balance.sub(fee));
    });

    it("Offchain withdrawal request (token != feeToken)", async () => {
      await createExchange();

      const keyPair = exchangeTestUtil.getKeyPairEDDSA();
      const owner = exchangeTestUtil.testContext.orderOwners[0];
      const wallet = exchangeTestUtil.wallets[realmID][0];
      const balance = new BN(web3.utils.toWei("4", "ether"));
      const toWithdraw = new BN(web3.utils.toWei("5", "ether"));
      const token = "ETH";
      const feeToken = "LRC";
      const fee = new BN(web3.utils.toWei("0.5", "ether"));

      // Deposit token
      const depositInfo = await exchangeTestUtil.deposit(realmID, owner,
                                                         keyPair.secretKey, keyPair.publicKeyX, keyPair.publicKeyY,
                                                         token, balance);
      // Deposit feeToken
      await exchangeTestUtil.deposit(realmID, owner,
                                     keyPair.secretKey, keyPair.publicKeyX, keyPair.publicKeyY,
                                     feeToken, fee);
      const accountID = depositInfo.accountID;
      await exchangeTestUtil.commitDeposits(realmID);

      const witdrawalRequest = await exchangeTestUtil.requestWithdrawalOffchain(
        realmID, accountID, token, toWithdraw,
        feeToken, fee, 40, wallet.walletAccountID,
      );
      await exchangeTestUtil.commitOffchainWithdrawalRequests(realmID);
      await exchangeTestUtil.verifyPendingBlocks(realmID);

      // Withdraw
      const blockIdx = (await exchange.getBlockHeight()).toNumber();
      await withdrawChecked(blockIdx, 0,
                            accountID, token,
                            owner, balance);
    });

    it("Withdraw (normal account)", async () => {
      await createExchange();

      const keyPair = exchangeTestUtil.getKeyPairEDDSA();
      const ownerA = exchangeTestUtil.testContext.orderOwners[0];
      const ownerB = exchangeTestUtil.testContext.orderOwners[1];

      const balanceA = new BN(web3.utils.toWei("7", "ether"));
      const toWithdrawA = new BN(web3.utils.toWei("4", "ether"));
      const tokenA = exchangeTestUtil.getTokenAddress("ETH");

      const balanceB = new BN(web3.utils.toWei("1", "ether"));
      const toWithdrawB = new BN(web3.utils.toWei("3", "ether"));
      const tokenB = exchangeTestUtil.getTokenAddress("ETH");

      const depositInfoA = await exchangeTestUtil.deposit(realmID, ownerA,
                                                          keyPair.secretKey, keyPair.publicKeyX, keyPair.publicKeyY,
                                                          tokenA, balanceA);
      const depositInfoB = await exchangeTestUtil.deposit(realmID, ownerB,
                                                          keyPair.secretKey, keyPair.publicKeyX, keyPair.publicKeyY,
                                                          tokenB, balanceB);
      await exchangeTestUtil.commitDeposits(realmID);

      // Do the request
      const witdrawalRequestA = await exchangeTestUtil.requestWithdrawalOnchain(
        realmID, depositInfoA.accountID, tokenA, toWithdrawA, ownerA,
      );
      /*const witdrawalRequestB = await exchangeTestUtil.requestWithdrawalOnchain(
        realmID, depositInfoB.accountID, tokenB, toWithdrawB, ownerB,
      );*/

      // Try to withdraw before the block is committed
      const nextBlockIdx1 = (await exchange.getBlockHeight()).toNumber() + 1;
      /*await expectThrow(
        exchange.withdrawFromApprovedWithdrawal(nextBlockIdx, witdrawalRequestA.slotIdx),
        "INVALID_BLOCKIDX",
      );*/

      // Commit the deposit
      await exchangeTestUtil.commitOnchainWithdrawalRequests(realmID);

      // Try to withdraw before the block is finalized
      await expectThrow(
        exchange.withdrawFromApprovedWithdrawal(nextBlockIdx1, 0),
        "BLOCK_NOT_FINALIZED",
      );

      // Verify the block
      await exchangeTestUtil.verifyPendingBlocks(realmID);

      // Withdraw
      await withdrawChecked(nextBlockIdx1, witdrawalRequestA.slotIdx,
                            depositInfoA.accountID, tokenA,
                            ownerA, toWithdrawA);

      const witdrawalRequestB = await exchangeTestUtil.requestWithdrawalOnchain(
        realmID, depositInfoB.accountID, tokenB, toWithdrawB, ownerB,
      );

      // Try to withdraw before the block is committed
      const nextBlockIdx2 = (await exchange.getBlockHeight()).toNumber() + 1;
      /*await expectThrow(
        exchange.withdrawFromApprovedWithdrawal(nextBlockIdx, witdrawalRequestA.slotIdx),
        "INVALID_BLOCKIDX",
      );*/

      // Commit the deposit
      await exchangeTestUtil.commitOnchainWithdrawalRequests(realmID);

      // Try to withdraw before the block is finalized
      await expectThrow(
        exchange.withdrawFromApprovedWithdrawal(nextBlockIdx2, 0),
        "BLOCK_NOT_FINALIZED",
      );

      // Verify the block
      await exchangeTestUtil.verifyPendingBlocks(realmID);

      // Withdraw
      await withdrawChecked(nextBlockIdx2, witdrawalRequestB.slotIdx,
                            depositInfoB.accountID, tokenB,
                            ownerB, balanceB);
    });

    it("Withdraw (fee-recipient account)", async () => {
      await createExchange();

      const walletA = exchangeTestUtil.wallets[realmID][0];
      const walletB = exchangeTestUtil.wallets[realmID][1];
      const ring: RingInfo = {
        orderA:
          {
            realmID,
            tokenS: "WETH",
            tokenB: "GTO",
            tokenF: "ETH",
            amountS: new BN(web3.utils.toWei("110", "ether")),
            amountB: new BN(web3.utils.toWei("200", "ether")),
            amountF: new BN(web3.utils.toWei("1.5", "ether")),
            walletAccountID: walletA.walletAccountID,
          },
        orderB:
          {
            realmID,
            tokenS: "GTO",
            tokenB: "WETH",
            tokenF: "LRC",
            amountS: new BN(web3.utils.toWei("200", "ether")),
            amountB: new BN(web3.utils.toWei("100", "ether")),
            amountF: new BN(web3.utils.toWei("90", "ether")),
            walletAccountID: walletB.walletAccountID,
          },
      };

      await exchangeTestUtil.setupRing(ring);
      await exchangeTestUtil.sendRing(realmID, ring);

      await exchangeTestUtil.commitDeposits(realmID);
      await exchangeTestUtil.commitRings(realmID);

      const witdrawalRequestA = await exchangeTestUtil.requestWithdrawalOnchain(
        realmID, ring.orderA.walletAccountID,
        ring.orderA.tokenF, ring.orderA.amountF.mul(new BN(2)),
        walletA.owner,
      );
      const witdrawalRequestB = await exchangeTestUtil.requestWithdrawalOnchain(
        realmID, ring.orderB.walletAccountID,
        ring.orderB.tokenF, ring.orderB.amountF.mul(new BN(2)),
        walletB.owner,
      );
      await exchangeTestUtil.commitOnchainWithdrawalRequests(realmID);
      await exchangeTestUtil.verifyPendingBlocks(realmID);

      const walletFeeA = ring.orderA.amountF.mul(new BN(ring.orderA.walletSplitPercentage)).div(new BN(100));
      const walletFeeB = ring.orderB.amountF.mul(new BN(ring.orderB.walletSplitPercentage)).div(new BN(100));

      // Withdraw
      const blockIdx = (await exchange.getBlockHeight()).toNumber();
      await withdrawChecked(blockIdx, 0,
                            ring.orderA.walletAccountID, ring.orderA.tokenF,
                            walletA.owner, walletFeeA, true);
      await withdrawChecked(blockIdx, 1,
                            ring.orderB.walletAccountID, ring.orderB.tokenF,
                            walletB.owner, walletFeeB, true);
    });

    it("Distribute withdrawals (by operator)", async () => {
      await createExchange();

      // Do deposits to fill a complete block
      const blockSize = exchangeTestUtil.offchainWithdrawalBlockSizes[0];
      const deposits: DepositInfo[] = [];
      for (let i = 0; i < blockSize; i++) {
        const orderOwners = exchangeTestUtil.testContext.orderOwners;
        const keyPair = exchangeTestUtil.getKeyPairEDDSA();
        const owner = orderOwners[i];
        const amount = new BN(web3.utils.toWei("" + Math.random() * 1000, "ether"));
        const token = exchangeTestUtil.getTokenAddress("LRC");
        const deposit = await exchangeTestUtil.deposit(realmID, owner,
                                                       keyPair.secretKey, keyPair.publicKeyX, keyPair.publicKeyY,
                                                       token, amount);
        deposits.push(deposit);
      }
      await exchangeTestUtil.commitDeposits(realmID);

      for (const deposit of deposits) {
        exchangeTestUtil.requestWithdrawalOffchain(
          realmID,
          deposit.accountID,
          deposit.token,
          deposit.amount,
          "LRC",
          new BN(0),
          0,
          exchangeTestUtil.wallets[realmID][0].walletAccountID,
        );
      }
      const blockIdx = (await exchange.getBlockHeight()).toNumber();
      await exchangeTestUtil.commitOffchainWithdrawalRequests(realmID);

      // Incorrect block index
      await expectThrow(
        exchange.distributeWithdrawals(123456, {from: exchangeTestUtil.exchangeOperator}),
        "INVALID_BLOCK_IDX",
      );

      // Block without any withdrawals
      await expectThrow(
        exchange.distributeWithdrawals(blockIdx, {from: exchangeTestUtil.exchangeOperator}),
        "INVALID_BLOCK_TYPE",
      );

      // Block not finalized yet
      await expectThrow(
        exchange.distributeWithdrawals(blockIdx + 1, {from: exchangeTestUtil.exchangeOperator}),
        "BLOCK_NOT_FINALIZED",
      );

      await exchangeTestUtil.verifyPendingBlocks(realmID);

      // Try to call from a non-operator address
      await expectThrow(
        exchange.distributeWithdrawals(blockIdx + 1, {from: exchangeTestUtil.testContext.deployer}),
        "UNAUTHORIZED",
      );

      // Distribute the withdrawals
      await distributeWithdrawalsChecked(blockIdx + 1, deposits, exchangeTestUtil.exchangeOperator);

      // Try to distribute again
      await expectThrow(
        exchange.distributeWithdrawals(blockIdx + 1, {from: exchangeTestUtil.exchangeOperator}),
        "WITHDRAWALS_ALREADY_DISTRIBUTED",
      );
    });

    it("Distribute withdrawals (not by operator)", async () => {
      await createExchange();

      // Deposit some LRC to stake for the exchange
      const depositer = exchangeTestUtil.testContext.operators[2];
      const stakeAmount = new BN(web3.utils.toWei("1234567", "ether"));
      await exchangeTestUtil.setBalanceAndApprove(depositer, "LRC", stakeAmount, loopring.address);

      await loopring.depositStake(realmID, stakeAmount, {from: depositer});

      // Do deposits to fill a complete block
      const blockSize = exchangeTestUtil.offchainWithdrawalBlockSizes[0];
      const deposits: DepositInfo[] = [];
      for (let i = 0; i < blockSize; i++) {
        const orderOwners = exchangeTestUtil.testContext.orderOwners;
        const keyPair = exchangeTestUtil.getKeyPairEDDSA();
        const owner = orderOwners[i];
        const amount = new BN(web3.utils.toWei("" + Math.random() * 1000, "ether"));
        const token = exchangeTestUtil.getTokenAddress("LRC");
        const deposit = await exchangeTestUtil.deposit(realmID, owner,
                                                       keyPair.secretKey, keyPair.publicKeyX, keyPair.publicKeyY,
                                                       token, amount);
        deposits.push(deposit);
      }
      await exchangeTestUtil.commitDeposits(realmID);

      for (const deposit of deposits) {
        exchangeTestUtil.requestWithdrawalOffchain(
          realmID,
          deposit.accountID,
          deposit.token,
          deposit.amount,
          "LRC",
          new BN(0),
          0,
          exchangeTestUtil.wallets[realmID][0].walletAccountID,
        );
      }
      const blockIdx = (await exchange.getBlockHeight()).toNumber();
      await exchangeTestUtil.commitOffchainWithdrawalRequests(realmID);

      await exchangeTestUtil.verifyPendingBlocks(realmID);

      // Try to call from a non-operator address
      await expectThrow(
        exchange.distributeWithdrawals(blockIdx + 1, {from: exchangeTestUtil.testContext.deployer}),
        "UNAUTHORIZED",
      );

      // Wait the max time only the operator can do it
      await exchangeTestUtil.advanceBlockTimestamp(exchangeTestUtil.MAX_TIME_TO_DISTRIBUTE_WITHDRAWALS + 1);

      // Distribute the withdrawals
      await distributeWithdrawalsChecked(blockIdx + 1, deposits, exchangeTestUtil.testContext.deployer, true);

      // Try to distribute again
      await expectThrow(
        exchange.distributeWithdrawals(blockIdx + 1, {from: exchangeTestUtil.testContext.deployer}),
        "WITHDRAWALS_ALREADY_DISTRIBUTED",
      );
    });

    describe("exchange owner", () => {
      it("should be able to disable the depositing of a token", async () => {
        await createExchange();

        const keyPair = exchangeTestUtil.getKeyPairEDDSA();
        const owner = exchangeTestUtil.testContext.orderOwners[0];
        const tokenA = exchangeTestUtil.getTokenAddress("GTO");
        const tokenB = exchangeTestUtil.getTokenAddress("REP");
        const amount = new BN(web3.utils.toWei("321", "ether"));

        // The correct deposit fee expected by the contract
        const fees = await exchange.getFees();
        const acountCreationFee = fees._accountCreationFeeETH;

        // Make sure the owner has enough tokens
        await exchangeTestUtil.setBalanceAndApprove(owner, tokenA, amount.mul(new BN(10)));
        await exchangeTestUtil.setBalanceAndApprove(owner, tokenB, amount.mul(new BN(10)));

        // Everything correct
        await createOrUpdateAccountChecked(keyPair, owner, acountCreationFee);

        // Disable token deposit for GTO
        await exchange.disableTokenDeposit(tokenA, {from: exchangeTestUtil.exchangeOwner});

        // Try to disable it again
        await expectThrow(
          exchange.disableTokenDeposit(tokenA, {from: exchangeTestUtil.exchangeOwner}),
          "TOKEN_DEPOSIT_ALREADY_DISABLED",
        );

        // Try to deposit
        await expectThrow(
          exchange.deposit(tokenA, amount, {from: owner, value: fees._depositFeeETH}),
          "TOKEN_DEPOSIT_DISABLED",
        );

        // Deposit another token
        await exchange.deposit(tokenB, amount, {from: owner, value: fees._depositFeeETH});

        // Enable it again
        await exchange.enableTokenDeposit(tokenA, {from: exchangeTestUtil.exchangeOwner});

        // Try to enable it again
        await expectThrow(
          exchange.enableTokenDeposit(tokenA, {from: exchangeTestUtil.exchangeOwner}),
          "TOKEN_DEPOSIT_ALREADY_ENABLED",
        );

        // Try the deposit again
        await exchange.deposit(tokenA, amount, {from: owner, value: fees._depositFeeETH});
      });

      it("should not be able to disable deposits for LRC/ETH/WETH", async () => {
        await createExchange();

        const owner = exchangeTestUtil.exchangeOwner;
        // Try to disable ETH
        await expectThrow(
          exchange.disableTokenDeposit(exchangeTestUtil.getTokenAddress("ETH"), {from: owner}),
          "ETHER_CANNOT_BE_DISABLED",
        );
        // Try to disable WETH
        await expectThrow(
          exchange.disableTokenDeposit(exchangeTestUtil.getTokenAddress("WETH"), {from: owner}),
          "WETH_CANNOT_BE_DISABLED",
        );
        // Try to disable LRC
        await expectThrow(
          exchange.disableTokenDeposit(exchangeTestUtil.getTokenAddress("LRC"), {from: owner}),
          "LRC_CANNOT_BE_DISABLED",
        );
      });
    });

    describe("anyone", () => {
      it("should not be able to disable/enable the depositing of a token", async () => {
        await createExchange();

        const token = exchangeTestUtil.getTokenAddress("GTO");

        // Try to disable the token
        await expectThrow(
          exchange.disableTokenDeposit(token),
          "UNAUTHORIZED",
        );

        // Disable token deposit for GTO
        await exchange.disableTokenDeposit(token, {from: exchangeTestUtil.exchangeOwner});

        // Try to enable it again
        await expectThrow(
          exchange.enableTokenDeposit(token),
          "UNAUTHORIZED",
        );
      });
    });

  });
});

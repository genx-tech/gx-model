CREATE TABLE IF NOT EXISTS `mt4Config` (
  `config` INT(10) NOT NULL DEFAULT 0,
  `valueInt` INT(10) NULL,
  `valueStr` CHAR(255) NULL,
  PRIMARY KEY (`config`)
);

CREATE TABLE IF NOT EXISTS `mt4Daily` (
  `login` INT(10) NOT NULL DEFAULT 0,
  `time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `group` CHAR(16) NOT NULL DEFAULT "",
  `bank` CHAR(64) NOT NULL DEFAULT "",
  `balancePrev` DOUBLE(22) NOT NULL DEFAULT 0,
  `balance` DOUBLE(22) NOT NULL DEFAULT 0,
  `deposit` DOUBLE(22) NOT NULL DEFAULT 0,
  `credit` DOUBLE(22) NOT NULL DEFAULT 0,
  `profitClosed` DOUBLE(22) NOT NULL DEFAULT 0,
  `profit` DOUBLE(22) NOT NULL DEFAULT 0,
  `equity` DOUBLE(22) NOT NULL DEFAULT 0,
  `margin` DOUBLE(22) NOT NULL DEFAULT 0,
  `marginFree` DOUBLE(22) NOT NULL DEFAULT 0,
  `modifyTime` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`login`, `time`)
);

CREATE TABLE IF NOT EXISTS `mt4Prices` (
  `symbol` CHAR(16) NOT NULL DEFAULT "",
  `time` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `bid` DOUBLE(22) NOT NULL DEFAULT 0,
  `ask` DOUBLE(22) NOT NULL DEFAULT 0,
  `low` DOUBLE(22) NOT NULL DEFAULT 0,
  `high` DOUBLE(22) NOT NULL DEFAULT 0,
  `direction` INT(10) NOT NULL DEFAULT 0,
  `digits` INT(10) NOT NULL DEFAULT 0,
  `spread` INT(10) NOT NULL DEFAULT 0,
  `modifyTime` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`symbol`)
);

CREATE TABLE IF NOT EXISTS `mt4Trades` (
  `ticket` INT(10) NOT NULL DEFAULT 0,
  `login` INT(10) NOT NULL DEFAULT 0,
  `symbol` CHAR(16) NOT NULL DEFAULT "",
  `digits` INT(10) NOT NULL DEFAULT 0,
  `cmd` INT(10) NOT NULL DEFAULT 0,
  `volume` INT(10) NOT NULL DEFAULT 0,
  `openTime` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `openPrice` DOUBLE(22) NOT NULL DEFAULT 0,
  `sl` DOUBLE(22) NOT NULL DEFAULT 0,
  `tp` DOUBLE(22) NOT NULL DEFAULT 0,
  `closeTime` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expiration` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `reason` INT(10) NOT NULL DEFAULT 0,
  `convRate1` DOUBLE(22) NOT NULL DEFAULT 0,
  `convRate2` DOUBLE(22) NOT NULL DEFAULT 0,
  `commission` DOUBLE(22) NOT NULL DEFAULT 0,
  `commissionAgent` DOUBLE(22) NOT NULL DEFAULT 0,
  `swaps` DOUBLE(22) NOT NULL DEFAULT 0,
  `closePrice` DOUBLE(22) NOT NULL DEFAULT 0,
  `profit` DOUBLE(22) NOT NULL DEFAULT 0,
  `taxes` DOUBLE(22) NOT NULL DEFAULT 0,
  `comment` CHAR(32) NOT NULL DEFAULT "",
  `internalId` INT(10) NOT NULL DEFAULT 0,
  `marginRate` DOUBLE(22) NOT NULL DEFAULT 0,
  `timestamp` INT(10) NOT NULL DEFAULT 0,
  `magic` INT(10) NOT NULL DEFAULT 0,
  `gwVolume` INT(10) NOT NULL DEFAULT 0,
  `gwOpenPrice` INT(10) NOT NULL DEFAULT 0,
  `gwClosePrice` INT(10) NOT NULL DEFAULT 0,
  `modifyTime` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`ticket`),
  KEY (`login`),
  KEY (`cmd`),
  KEY (`openTime`),
  KEY (`closeTime`),
  KEY (`timestamp`)
);

CREATE TABLE IF NOT EXISTS `mt4Users` (
  `login` INT(10) NOT NULL DEFAULT 0,
  `group` CHAR(16) NOT NULL DEFAULT "",
  `enable` INT(10) NOT NULL DEFAULT 0,
  `enableChangePass` INT(10) NOT NULL DEFAULT 0,
  `enableReadonly` INT(10) NOT NULL DEFAULT 0,
  `enableOtp` INT(10) NOT NULL DEFAULT 0,
  `passwordPhone` CHAR(32) NOT NULL DEFAULT "",
  `name` CHAR(128) NOT NULL DEFAULT "",
  `country` CHAR(32) NOT NULL DEFAULT "",
  `city` CHAR(32) NOT NULL DEFAULT "",
  `state` CHAR(32) NOT NULL DEFAULT "",
  `zipcode` CHAR(16) NOT NULL DEFAULT "",
  `address` CHAR(128) NOT NULL DEFAULT "",
  `leadSource` CHAR(32) NOT NULL DEFAULT "",
  `phone` CHAR(32) NOT NULL DEFAULT "",
  `email` CHAR(48) NOT NULL DEFAULT "",
  `comment` CHAR(64) NOT NULL DEFAULT "",
  `id` CHAR(32) NOT NULL DEFAULT "",
  `status` CHAR(16) NOT NULL DEFAULT "",
  `regdate` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `lastdate` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `leverage` INT(10) NOT NULL DEFAULT 0,
  `agentAccount` INT(10) NOT NULL DEFAULT 0,
  `timestamp` INT(10) NOT NULL DEFAULT 0,
  `balance` DOUBLE(22) NOT NULL DEFAULT 0,
  `prevmonthbalance` DOUBLE(22) NOT NULL DEFAULT 0,
  `prevbalance` DOUBLE(22) NOT NULL DEFAULT 0,
  `credit` DOUBLE(22) NOT NULL DEFAULT 0,
  `interestrate` DOUBLE(22) NOT NULL DEFAULT 0,
  `taxes` DOUBLE(22) NOT NULL DEFAULT 0,
  `sendReports` INT(10) NOT NULL DEFAULT 0,
  `mqid` INT(10) UNSIGNED NOT NULL DEFAULT 0,
  `userColor` INT(10) NOT NULL DEFAULT 0,
  `equity` DOUBLE(22) NOT NULL DEFAULT 0,
  `margin` DOUBLE(22) NOT NULL DEFAULT 0,
  `marginLevel` DOUBLE(22) NOT NULL DEFAULT 0,
  `marginFree` DOUBLE(22) NOT NULL DEFAULT 0,
  `currency` CHAR(16) NOT NULL DEFAULT "",
  `apiData` VARBINARY(65535) NULL,
  `modifyTime` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`login`),
  KEY (`timestamp`)
);


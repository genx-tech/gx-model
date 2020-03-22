CREATE TABLE IF NOT EXISTS `user` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `email` VARCHAR(200) NULL,
  `mobile` VARCHAR(20) NULL,
  `password` VARCHAR(200) NOT NULL DEFAULT "",
  `passwordSalt` CHAR(8) NOT NULL,
  `locale` TEXT NOT NULL,
  `status` ENUM('inactive', 'active', 'disabled', 'forbidden', 'deleted') NOT NULL,
  `testToken` DATETIME NOT NULL,
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
  `statusInactiveTimestamp` DATETIME NULL,
  `statusActiveTimestamp` DATETIME NULL,
  `statusDisabledTimestamp` DATETIME NULL,
  `statusForbiddenTimestamp` DATETIME NULL,
  `statusDeletedTimestamp` DATETIME NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY (`email`),
  UNIQUE KEY (`mobile`)
) AUTO_INCREMENT=100000;

CREATE TABLE IF NOT EXISTS `profile` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `firstName` VARCHAR(40) NULL,
  `middleName` VARCHAR(40) NULL,
  `surName` VARCHAR(40) NULL,
  `dob` DATETIME NULL,
  `avatar` VARCHAR(200) NULL,
  `gender` VARCHAR(1) NOT NULL DEFAULT "",
  `owner` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
);

CREATE TABLE IF NOT EXISTS `gender` (
  `code` VARCHAR(1) NOT NULL DEFAULT "",
  `name` VARCHAR(20) NULL,
  PRIMARY KEY (`code`)
);

CREATE TABLE IF NOT EXISTS `group` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255) NULL,
  PRIMARY KEY (`id`)
);

CREATE TABLE IF NOT EXISTS `userGroup` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `createdAt` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `user` INT NOT NULL DEFAULT 0,
  `group` INT NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY (`group`, `user`)
);


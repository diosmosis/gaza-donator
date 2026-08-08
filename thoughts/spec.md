# palestine-donator

this is a script that automatically donates to people in palestine who have setup gofundme or chuffed accounts.

## configuration

- the total amount of money that can be donated (for example $200)
- the credit card information to use (this will likely be a privacy.com card that is merchant locked and with a spending limit)
- the amount of money per individual donation (for example $10)
- the intended donation recurrence period (eg, weekly, monthly)

## recipients

the people who should be donated to must all be "Gaza Verified" (see gaza-verified.org and gaza.onl/swagger/).

when choosing people to donate to, those who have received the least amount of money in the last recurrence period should be chosen.

## script execution

- based on configuration, determine who should be donated to
- print out the list of recipients along with how much donations they have received in the last recurrence period
- confirm with the user they want to continue with donating
- after confirmed, donate to each recipient using saved card details. if using a card fails, retry a couple times. if it continually fails, stop and print the summary.

## technology

- use node.js
- if browsing/scraping a webpage is needed, use puppeteer
- if you want to use something else, ask

## notes

- dry-run by default, with an explicit command to donate
- api requests should be cached with a ttl of 15 mins
- data from the api may need to be verified by opening and scraping a webpage


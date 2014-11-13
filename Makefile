.PHONY: npm all test

NPM_UP_TO_DATE:=.npm-up-to-date
NODE=node

all: test

npm: $(NPM_UP_TO_DATE)

$(NPM_UP_TO_DATE): package.json
	npm install
	touch $(NPM_UP_TO_DATE)

test-suite: npm
	$(NODE) tests/test-suite.js

unit-tests: npm
	$(NODE) tests/test-node-unit.js

timing-tests: npm
	$(NODE) tests/test-node.js

dormann-test: npm
	$(NODE) tests/test-dormann.js

short-tests: unit-tests timing-tests dormann-test
long-tests: test-suite 

test: short-tests long-tests

.PHONY: tests short-tests test dormann-test timing-tests unit-tests test-suite npm all

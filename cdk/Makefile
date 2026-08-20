# CC-BY-SA-4.0
# 2026 Pablo - VPC PUBLIC/PRIVATE SETUP - CDK MAKEFILE

STACK        := VpcPublicPrivateSetup
TEMPLATE_OUT := ../cdk-vpc-vpn-gw.yaml
ORIGINAL     := ../vpc-public-private-setup-orig.yaml.bkp
CDK          := npx cdk

##
# Sanity checks
NODE   := $(shell command -v node 2> /dev/null)
NPM    := $(shell command -v npm 2> /dev/null)
AWSCLI := $(shell command -v aws 2> /dev/null)

ifndef NODE
$(error "Did not find required node executable!")
endif

ifndef NPM
$(error "Did not find required npm executable!")
endif

ifndef AWSCLI
$(error "Did not find required AWS CLI executable!")
endif

##
# PHONY Targets - will always run
.PHONY: prechecks install build test synth template deploy compare clean all

##
# Targets
prechecks:
	@echo -e "\nRunning prechecks..."
	@./tools/check-prereqs.sh
	@echo -e "[OK] - Prechecks passed\n"

install: prechecks
	@echo -e "\nInstalling CDK dependencies..."
	@npm install
	@echo -e "[OK] - Dependencies installed\n"

# Compile the construct to dist/ (JS + type declarations) for module consumers.
build: install
	@echo -e "\nBuilding module (tsc -> dist/)..."
	@npx tsc -p tsconfig.build.json
	@echo -e "[OK] - Built dist/\n"

# Run the unit tests (both the parametric and props paths).
test: install
	@echo -e "\nRunning tests..."
	@npx jest
	@echo -e "[OK] - Tests passed\n"

# Produce the deployable CloudFormation template (YAML) from the CDK app.
# --path-metadata/--version-reporting false keep the output free of CDK-specific
# metadata so it reads as a plain, hand-written-style template.
synth: install
	@echo -e "\nSynthesizing $(STACK) to $(TEMPLATE_OUT)..."
	@$(CDK) synth $(STACK) --path-metadata false --version-reporting false > $(TEMPLATE_OUT)
	@echo -e "[OK] - Wrote $(TEMPLATE_OUT)\n"

# Alias for synth: produce the deployable CloudFormation template.
template: synth

# Build and deploy the stack directly with CDK. Pass extra args via CDK_ARGS, e.g.
# make deploy CDK_ARGS="--parameters NetworkMode=PublicPrivateCustomRouting"
deploy: install
	@echo -e "\nDeploying $(STACK)..."
	@$(CDK) deploy $(STACK) $(CDK_ARGS)
	@echo -e "[OK] - Deploy completed\n"

# Structural diff of the generated template against the original reference.
# The reference is a local .bkp that goes away as the template evolves, so skip
# gracefully when it is absent instead of failing.
compare: synth
	@if [ -f "$(ORIGINAL)" ]; then \
		echo -e "\nComparing generated template against $(ORIGINAL)..."; \
		node ./tools/compare-templates.js "$(ORIGINAL)" ./cdk.out/$(STACK).template.json; \
		echo -e "[OK] - Compare completed\n"; \
	else \
		echo -e "\n[SKIP] - Reference $(ORIGINAL) not found; nothing to compare against.\n"; \
	fi

clean:
	@echo -e "\nCleaning..."
	@rm -rf cdk.out node_modules
	@echo -e "[OK] - Clean completed\n"

all: synth
	@echo -e "[OK] - Build completed!\n"

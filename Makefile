# ==================== 镜像仓库配置（改成你自己的）====================
# Docker Hub :  REGISTRY 留空，NAMESPACE=你的用户名
# 阿里云 ACR :  REGISTRY=registry.cn-hangzhou.aliyuncs.com NAMESPACE=你的命名空间
#              （仓库需要先在阿里云控制台创建）
REGISTRY  ?= ccr.ccs.tencentyun.com
NAMESPACE ?= vpn-server
IMAGE     ?= wg-easy

# 标签默认取 git 短哈希；也可指定：make deploy TAG=v1.0.0
TAG       ?= $(shell git rev-parse --short HEAD)
PLATFORMS ?= linux/amd64,linux/arm64

ifeq ($(strip $(REGISTRY)),)
FULL_IMAGE := $(NAMESPACE)/$(IMAGE)
else
FULL_IMAGE := $(REGISTRY)/$(NAMESPACE)/$(IMAGE)
endif

BUILDER := wg-easy-builder

.PHONY: login builder build deploy show clean

login: ## 登录镜像仓库（首次或凭证过期时执行一次）
	@if [ -z "$(strip $(REGISTRY))" ]; then \
		docker login; \
	else \
		docker login $(REGISTRY); \
	fi

builder: ## 确保 buildx 多架构 builder 存在（带 docker.io 镜像加速配置）
	@docker buildx inspect $(BUILDER) >/dev/null 2>&1 || \
		docker buildx create --name $(BUILDER) --driver docker-container \
			--buildkitd-config buildkitd.toml

build: builder ## 本机构建当前平台镜像（不推送，用于本地验证）
	docker buildx build --builder $(BUILDER) --load \
		-t $(FULL_IMAGE):$(TAG) .

deploy: builder ## 构建多架构镜像并推送到镜像空间
	docker buildx build --builder $(BUILDER) --platform $(PLATFORMS) \
		-t $(FULL_IMAGE):$(TAG) -t $(FULL_IMAGE):latest --push .

show: ## 显示当前完整镜像名:标签
	@echo $(FULL_IMAGE):$(TAG)

clean: ## 删除 buildx builder
	@docker buildx rm $(BUILDER) 2>/dev/null || true

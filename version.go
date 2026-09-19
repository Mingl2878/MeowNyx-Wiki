package main

import (
	_ "embed"
	"strings"
)

//go:embed version.txt
var applicationVersion string

func applicationTitle() string {
	return "小黑猫 wiki 版本" + strings.TrimSpace(applicationVersion)
}

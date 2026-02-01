#!/bin/bash

echo "=== Cloud P1 Driver File Structure Check ==="
echo ""

echo "Checking driver directory..."
if [ -d "drivers/cloud_p1" ]; then
    echo "✓ drivers/cloud_p1/ exists"
    ls -la drivers/cloud_p1/
else
    echo "✗ drivers/cloud_p1/ NOT FOUND"
    echo "  Should be: drivers/cloud_p1/"
    if [ -d "drivers/cloud-p1" ]; then
        echo "  Found: drivers/cloud-p1/ (WRONG - use underscore not dash)"
    fi
fi

echo ""
echo "Checking pair directory..."
if [ -d "drivers/cloud_p1/pair" ]; then
    echo "✓ drivers/cloud_p1/pair/ exists"
    ls -la drivers/cloud_p1/pair/
else
    echo "✗ drivers/cloud_p1/pair/ NOT FOUND"
fi

echo ""
echo "Checking required files..."
files=(
    "drivers/cloud_p1/driver.js"
    "drivers/cloud_p1/device.js"
    "drivers/cloud_p1/driver.compose.json"
    "drivers/cloud_p1/pair/login.html"
    "drivers/cloud_p1/pair/list_locations.html"
    "lib/homewizard-cloud-api.js"
)

for file in "${files[@]}"; do
    if [ -f "$file" ]; then
        echo "✓ $file"
    else
        echo "✗ $file MISSING"
    fi
done

echo ""
echo "Checking app.json (generated)..."
if [ -f "app.json" ]; then
    echo "✓ app.json exists"
    if grep -q "cloud_p1" app.json; then
        echo "✓ app.json contains cloud_p1 driver"
        echo ""
        echo "Pair flow in app.json:"
        cat app.json | grep -A 30 '"id": "cloud_p1"' | grep -A 20 '"pair"'
    else
        echo "✗ app.json does NOT contain cloud_p1 driver"
        echo "  Run: homey app build"
    fi
else
    echo "✗ app.json NOT FOUND"
    echo "  Run: homey app build"
fi

echo ""
echo "Checking package.json dependencies..."
if [ -f "package.json" ]; then
    if grep -q '"ws"' package.json; then
        echo "✓ ws dependency found"
    else
        echo "✗ ws dependency MISSING"
        echo "  Add: \"ws\": \"^8.16.0\" to dependencies"
    fi
else
    echo "✗ package.json NOT FOUND"
fi

echo ""
echo "=== Summary ==="
echo "If any files are missing or in wrong location, fix and run:"
echo "  homey app build"
echo "  homey app install"
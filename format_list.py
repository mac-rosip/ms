import re

# Read the file
with open('1WINDSTAR@MSN.json', 'r') as f:
    lines = f.readlines()

output = []

# Process all lines
for line in lines:
    # Extract the entry part before "], "address":"
    match = re.search(r'(.+?)\], "address":', line)
    if match:
        entry = match.group(1)
        parts = entry.split()
        if len(parts) >= 2:
            email = parts[0]
            numbers = []
            name_start = 1
            for i in range(1, len(parts)):
                cleaned = parts[i].strip('",')
                if cleaned.isdigit():
                    numbers.append(cleaned)
                else:
                    name_start = i
                    break
            if numbers and name_start < len(parts):
                number = numbers[0]
                name_parts = parts[name_start:]
                if name_parts:
                    firstname = name_parts[0].strip('"')
                    output.append(f"{email} {number} {firstname}")

# Write to a new file
with open('formatted.txt', 'w') as f:
    for line in output:
        f.write(line + '\n')

print("Formatted list written to formatted.txt")